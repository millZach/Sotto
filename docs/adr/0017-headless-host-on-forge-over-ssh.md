# A headless host on the user's own Linux machine, reached over SSH first

## Status

Proposed — September 19, 2026. Resolves the two questions ADR-0016 left open (which remote path ships first, and what pairing looks like to the user) and adds Linux as a host-only platform. Accepting it is the owner's decision; the tickets under the wayfinder map that cites this ADR are the work.

## Context

ADR-0016 drew the line: the host owns the providers, the worktrees and the event store; the client draws threads and sends commands, and holds no provider identity of its own. `HostService` is that line in code, `LocalHostService` over IPC is its only implementation, and pairing records and tokens exist without anything listening. The ADR left the transport beyond loopback, and the pairing flow as the user sees it, for the owner to decide.

The owner has now said where the host will run: a Linux machine of their own, `forge`, that runs the coding agents while the user works from a laptop and, later, a phone. That settles three things that were open and raises one that was not.

- The host and the workspace stay in one process. The worry in the identity discussion, adapters running apart from the workspace that names their threads, does not arise: both move to `forge` together, so the provider's identifier stays in the adapter's own alias file on the same machine, and the rule that only the adapter speaks the provider's language survives unchanged (ADR-0002).
- Linux becomes a platform, but a host-only one. There is no window, tray, hotkey, widget or design capture on `forge`; the whole of AGENTS.md's design gate does not apply to it. What does apply is a release path and the runtime manifest.
- The first remote path has a natural answer. The user already reaches `forge` over SSH. T3 Code's remote design (`docs/internals/remote.md` in the pinned source) treats SSH as both a launcher and a tunnel: desktop main spawns `ssh`, starts or discovers the server on the far side, forwards a local port, and the client speaks to that port exactly as it would to a local server. No port is opened on the host, authentication is SSH's own, and a server the launcher did not start survives a client disconnect.
- One thread ID space is no longer enough. The laptop can keep running local threads while `forge` runs others, and a client showing both must be able to say which host a thread belongs to. T3 gives each environment an ID that survives restarts and endpoint changes, and a project and its threads belong to one environment.

## Decision

**The host runs headless on Linux as a Node process, from the same source.** A second entry point, `src/host/index.ts`, starts everything `src/main/index.ts` starts today except the Electron pieces: no `BrowserWindow`, tray, global hotkey, paste, updater or widget. The agent stack already imports Electron in exactly one file, `src/main/agents/ipc.ts`, and that file is the IPC client transport; the headless host does not load it. Production dependencies stay exactly `zod`. The host is packaged as a plain archive of the built output plus `package.json`, run with the Node version the release pins, and never with `electron-builder`.

**SSH is the first remote path, and the desktop app is the launcher.** Settings → Hosts gains an entry for an SSH target (`user@forge`, an optional identity file). Connecting spawns the platform's `ssh` executable directly, never through a shell, checks for a running host on the far side, starts one from the installed archive if there is none, forwards a local port to the host's loopback listener, and opens a socket client on the forwarded port. The host listens on loopback only. Disconnecting stops a host the launcher started and leaves one it discovered. This is the shape of T3's `packages/ssh`, taken without its Effect runtime.

**The socket client speaks the host service and nothing more.** `HostService` gains a second implementation, `SocketHostService`, that carries the same four things the local one does: events after a sequence number, the shell, one thread's detail, and commands with a client identity. The desktop window becomes a client of whichever host it is connected to, and the local host becomes one host among several rather than the only one. A setting turns the local host off entirely, for a laptop that only ever views `forge`.

**Pairing happens over the tunnel, once per client.** Because the tunnel is already authenticated by SSH, pairing is not a second lock on the door; it is what gives the client an identity the host can name on every answer (ADR-0016's attribution). The first connection over a new tunnel asks the host for a pairing code, shows it in the desktop app, and the user confirms it there; the client redeems it for its token and keeps signing sessions with it. The code is only ever shown on the client that asked, so there is nothing to read across the room until a second path (a socket behind Tailscale Serve, or a phone) exists. Admission is never authority: whether a paired client's answer counts as a grant is a policy record (ADR-0004), and the local desktop window always may answer.

**Every host has a host ID, and every thread carries it.** The host mints one UUID on first start and stores it in its data folder; threads, projects and the shell carry `hostId`. A client keyed on Sotto thread ID alone would collide the day two hosts each mint a thread; keyed on `(hostId, threadId)` it can show `forge` and the laptop in one sidebar. Existing threads on the laptop are stamped with the laptop's host ID by a one-time migration.

**Privacy stays a README sentence.** The host contacts nothing it does not contact today; the laptop contacts `forge` over SSH, which the user configured. The README's "Privacy and cost" section says so before the first listening socket lands, per ADR-0016.

## Considered options

- **Tailscale Serve first.** Gives a URL any device can open, which is what the phone will need, at the cost of a certificate story, a listening socket on the tailnet and a pairing code that must be read across devices. It is the second path, not the first: SSH reaches the machine the user already reaches, with no new surface.
- **A shared thread record with the provider's ID on it, as T3 does.** Considered again when the remote plan became concrete. It solves nothing here, because the adapters and the workspace move together, and it widens what a socket could carry for no reader that needs it. Rejected.
- **Electron on Linux, running invisibly.** Keeps one entry point, but drags a display server, a windowing toolkit and the design gate onto a machine with none of them. The Electron-specific code is a thin layer at the top of `src/main/index.ts`; splitting the entry is cheaper than pretending the window exists.
- **A separate server repository.** T3's layout. Sotto is one app with one `src/shared`, one glossary and one set of gates; a second repository would need a shared package and a release cadence of its own before it paid for itself. The headless host is a second entry point in this repository until that stops being true.

## Consequences

- `src/main/index.ts` is split into what any host does and what only the desktop does, and the headless entry proves the split: a test starts the host without Electron and drives it through `HostService`.
- Linux is on the release path for the host archive only: build on the Windows PC, verify the runtime manifest, publish beside the installers. There is no Linux design gate and no Linux desktop build.
- CI gains one job that starts the headless host and runs the adapter contract through the socket client, so the socket transport passes the same test the IPC one does.
- The phone client becomes a question of the shell and detail contracts, not of the host: both are the same over the socket as over IPC. Making them a public API is its own ticket.
- What stays open after this ADR: the second remote path and its pairing UX, when the phone client is designed.
