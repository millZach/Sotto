# A thread on a paired host opens its terminal over SSH

## Status

Accepted November 2, 2026, by Zach's picks on question cards, from the prototype kept at the tag `prototype/paired-host-terminal`. **Number provisional until merge** (docs/agents/domain.md).

It is an Owl feature (`paired-host-terminal`, ADR-0072). Stable keeps the greyed button of ADR-0182 until Zach sends it.

Amends [ADR-0182](0182-tools-and-the-terminal-drawer-return-to-a-panes-header.md) decision 4, [ADR-0049](0049-a-thread-pane-has-its-own-terminal-drawer.md) and the "Remote folder, terminal and paste actions explain the owning machine" line of [ADR-0025](0025-headless-host-and-client-identity.md). It changes nothing in the host protocol, in pairing or in the policy records.

## Context

A thread on a paired host had no terminal. Its drawer's button was greyed and said to open it on that machine, which is the button Zach sees most, since he views forge's threads from his laptop.

The issue (#2071, and #211 before it) expected the host to own these shells: a new host feature, with output as a resumable stream, so a shell outlives a dropped connection. Reading the release path showed what that costs. The host archive holds no native code on purpose: `verify-host-archive.mjs` refuses any native binary, `runtime-manifest.json` says `nativeModules: []`, and `release-external-dependencies.mjs` says never to copy the desktop's `node-pty` into it. So the host has no way to make a terminal. It would need a `node-pty` build in every host archive and new protocol, and any desktop token that passed the check could open a shell directly, with #1692 still open.

Zach saw both routes side by side, including what a dropped connection does on each, and chose SSH.

## Decision

**1. The shell runs over the user's own SSH.** A press on the drawer's button, or on Tools' Terminal, starts `ssh -tt <host>` in a terminal on this computer, through the same `TerminalService` that runs local shells. Nothing new runs on the host, and a host of any version works. That service gains one seam, `HostedTerminals`, which says what a thread on a paired host is and how to launch its shell; every local shell runs as it did.

**2. Who may open one is whoever can already SSH in.** Sotto adds no check and no grant. The desktop uses the saved host's own target, port and identity file, and OpenSSH asks for anything it needs (a passphrase, a host key, a Tailscale approval) in the terminal itself, where the user can answer. Three things follow:

- A paired client gains nothing. No host operation opens a shell, so a phone, a code-paired client or a copied token (#1692) can do exactly what it could before. This leaves the pull request confirmation of #1691 as it is.
- The window names only a thread. The target, the arguments and the folder are worked out in main, from saved hosts and the host's own thread record. The window can't supply a host, a command or a flag.
- Nothing is answered on the user's behalf. This is the user's own press opening the user's own session, not a permission request (ADR-0004), and an agent has no way to ask for one.

Zach also chose "desktops set up over SSH only" for the route that ran on the host. Over SSH that choice has nothing left to decide, and a phone gets no terminal.

**3. A shell ends with its connection.** A dropped connection, a sleep long enough to lose it, or quitting Sotto ends the shell and whatever runs in it, as in any plain SSH window. `ssh` exits 255, and the terminal says "The connection to forge ended." with Reopen, which starts a new shell. Its output stays until then. A user who needs a command to outlive the connection runs tmux themselves. A restart of Sotto on the host doesn't touch the shell, since the shell isn't the host's.

The window keeps the shell through the host's own socket dropping and coming back, because the two connections are separate. The keepalive is 15 seconds with four misses, so a dead connection ends in about a minute rather than hanging, and a laptop that wakes on the same connection carries on.

**4. Disconnect, Stop host and Forget end the host's shells.** Their threads leave the page with them, and a running shell nobody can see or reach must not stay open on a machine the user just forgot.

**5. Where it starts.** The drawer starts in the thread's project folder and Tools' Terminal in its working copy, as on this computer, falling back from one to the other when `cd` fails, and then to the home folder. The folders come from what the host last published; nothing is asked of it. The remote command carries each folder as base64 so that no login shell (bash, zsh, fish) re-reads its quoting. It starts the account's `$SHELL` as a login shell. A folder written the Windows way runs PowerShell with an encoded command instead.

**6. The bar says where it is.** Zach picked A: the bar of a paired-host thread's terminal says "on forge", with a machine symbol, in the drawer and in Tools. A shell on another machine otherwise looks just like one here. Local terminals don't change. The tab is named `shell`, since this computer doesn't know the account's shell.

**7. Both terminals.** Tools' Terminal works too (Zach's pick). Its sentence "Terminal is on the host machine. Use this tool on the host." would otherwise have been false. The browser and test iPhone keep theirs. Shells still share the 32 slots, and the drawer's and Tools' still don't show each other's.

**8. Limits it keeps.**

- A reply's Run in terminal (ADR-0139) stays off on these threads. A command typed into a new shell could land in an SSH passphrase prompt.
- Pasting an image into one of these terminals is refused in plain words, since the file would have to reach the host. Nothing is pasted.
- A running shell doesn't hold the thread's worktree on the host, since the host doesn't know about it. The host could reclaim a worktree a shell is standing in.
- A link opened from the terminal opens on this computer, so `localhost` there means this computer.
- Sotto logs nothing a shell types or prints, as with any terminal. Saved records are the same reopen hints as ever.

## Consequences

- No host update, no new host feature and no native file: a desktop on Owl gets a working button against the host it already has.
- `node-pty` here must run `ssh`, which on Windows means Windows' own OpenSSH under ConPTY. `sshExecutable` picks the same binary the launcher does. Only a hand test on Windows proves that.
- `ControlMaster` stays off, as on every ssh Sotto starts, so a key with a passphrase and no agent asks again for each new shell.
- If a host can't be reached by SSH but its tailnet connection works (ADR-0053), the host's threads work and this terminal doesn't. SSH's own words say so in the terminal.
- #211 stays open only for the part this doesn't do: a shell that survives a dropped connection.

## Alternatives

- **The host runs the shell (`node-pty` in every host archive, a new host feature, `desktop && mayAnswer` as the check).** A build would survive the laptop sleeping and show what it printed meanwhile. It was what #2071 and #211 expected and what the prototype recommended. Zach chose SSH for the smaller surface: no native code on hosts, no new protocol, and no new power in a paired token.
- **Wrapping the remote shell in tmux when the host has it.** It would survive a drop, at the price of tmux's keys and scrollback in every terminal, on hosts that happen to have it. A user who wants it can type it.
- **Reading the folder from the host's Files before starting.** It would add a round trip and fail while the socket is down, when SSH may well be fine.
