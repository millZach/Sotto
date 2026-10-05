# A desktop reaches a host over its tailnet first

## Status

Accepted October 5, 2026. The owner delegated the open questions to the agent that wrote this ("Go ahead and do everything we discussed, no need to stop and ask me"), so the picks below are the owner's delegated picks, recorded as such. The design is variant C, "Setup-led", with variant A's controls, in `docs/prototypes/host-tailnet-prototype.html`. The plan, its pull requests and its risks are `docs/plans/host-tailnet-connection.md`. Amends [ADR-0025](0025-headless-host-and-client-identity.md) and [ADR-0050](0050-a-hosts-phone-access-is-turned-on-from-the-desktop.md), and, once the host side lands, `docs/host-protocol.md`. [ADR-0054](0054-a-host-can-start-at-boot-on-linux.md) is its companion: a host that starts at boot is what lets a desktop reach it with no SSH at all.

## Context

A desktop reaches a remote host only through an SSH port forward (ADR-0025). Every connect is an `ssh` sign-in, and on a tailnet whose policy holds Tailscale SSH in `check` mode, every connect after the check period has lapsed waits for the owner to approve it in a browser. On October 5 forge, the owner's headless host, asked for an approval on every relaunch of Sotto, and a host Sotto started does not come back after its machine restarts until a desktop connects over SSH and starts it.

Since ADR-0050 a host with phone access on already has a second loopback listener that Tailscale Serve carries to the tailnet over HTTPS, with no administrative routes, sharing the host's one pairing store. The desktop is paired with that host already. Everything a connected desktop needs from the socket (threads, commands, provider sign-in, client updates) works over a paired session, and SSH is needed only for what the launch script does: start, stop, update and the host's administrative routes.

The options considered:

1. **Keep SSH for every connection.** Rejected: it is what makes each relaunch ask for approval, and the long-lived forward is the only reason a dropped SSH connection drops the host's threads.
2. **Tailnet only.** Rejected: the first pairing, the `remote-answer` grant, start, stop and update all need the SSH session, and a host whose Serve is off, or whose machine is not on the tailnet, would become unreachable.
3. **Tailnet first, SSH when it does not answer.** Chosen.
4. **Trust Tailscale Serve's identity headers.** Rejected: they name a tailnet user, not a paired client, and ADR-0004 lets nothing but a policy record grant authority.

## Decision

**Names.** The desktop's connection to a host through the host's tailnet address, authenticated by its pairing, is a **tailnet connection**. The path every host has today is the **SSH connection**. The host's second loopback listener, which was the phone listener, is the **tailnet listener**: it now carries desktops as well as phones. The address the desktop uses, `https://<MagicDNS name>:<Serve port>`, is the host's **tailnet address**, learned from the host and never typed. An SSH connection opened for one administrative press and closed after it is an **admin session**. `CONTEXT.md` has all five.

**What a saved host stores.** `remoteHostSchema` stays as it is: it is strict, and an older Sotto would reset `remote-hosts.json` to an empty list if it met a new key. The new state lives beside it in `remote-host-tailnet.json` in the user data folder, keyed by the saved host's ID: which connection the owner prefers (`tailnet` or `ssh`, `tailnet` by default), the last tailnet address the host reported, and when it was seen. It changes through a Hosts command, not a setting, and Forget deletes the entry. An older Sotto ignores the file and keeps connecting over SSH.

**How the address is found.** The host records its tailnet address and who started it in its listener descriptor, and reports both in the launch result and in the authenticated hello. The real Serve port is reported, so a host that fell back from 8443 to another port is found without guessing. The desktop accepts only an `https:` address on a `*.ts.net` name. Matching the name against this computer's own `tailscale status` is evidence and nothing more. The host's identity is still its TLS certificate, the pairing token, and the session's host ID matching the saved host's.

**The order of a connect.**

1. If the owner prefers the tailnet, an address is known and this computer holds the host's pairing, the desktop opens the host service at the tailnet address: health within 5 seconds, then a session, then the socket. No `ssh` is spawned.
2. A tailnet connection that fails is classed, and the class decides what happens next. Unreachable (DNS, connect, TLS, a timeout, or 502 or 503 from Serve) and a host whose ID is not the saved one go to SSH. A refused pairing (401) goes to SSH, which pairs again over the forward exactly as today. A version mismatch stays final, as today.
3. Over SSH, the connect is today's launch, pairing and desktop grant. If the launch reported a tailnet address and the owner prefers the tailnet, the desktop then tries the tailnet; when it answers, the socket opens there and the forward closes. Otherwise the socket stays on the forward, and the row says so.
4. While connected over SSH with the tailnet preferred, the desktop tries the tailnet again every 5 minutes and moves across when it answers.
5. A drop, or a move from one connection to the other, marks the host's threads as reconnecting and swaps the connection in place, as a host update already does (ADR-0040). Threads, panes and the selection stay on the page. Only Forget and switching a host off take its threads away.
6. Retries keep the 3, 4, 8 and 16 second backoff. For a host that starts at boot whose last connection was a tailnet connection, the first 60 seconds of retries try the tailnet only, since the host restarts by itself and an SSH attempt would ask for an approval for nothing. After that each attempt tries the tailnet and then SSH.

**The desktop never pairs on the tailnet.** Its first pairing is always over SSH, at Add host, and the client refuses to redeem a code at any address that is not loopback. The pairing token is the same on both listeners, because the host has one pairing store.

**Admin sessions.** The SSH connection stops carrying the socket. Each press that needs the launch script or the host's administrative routes opens an admin session: the **Phones…** dialog for as long as it is open, **Stop host**, Forget's stop of a host Sotto started, **Update** from the press to the restart, **Start at boot** and **Stop starting at boot** (ADR-0054), saving **Edit connection** (which is a test connect), and pairing again after a 401. It begins with a connect, so a Tailscale approval shows inside the surface that asked for it, "Waiting for your approval in Tailscale" with **Open approval page**. It closes 60 seconds after its last use. The host's administrative token stays in memory for that one SSH connection, as ADR-0050 says. Provider sign-in, client updates and Forget's revoke go over the socket; host setup and provider jobs are agent threads that run `ssh` themselves, unchanged.

**Authority.** The tailnet adds none. The `remote-answer` grant is still written only by the launch script over SSH (ADR-0025, September 29 amendment). The tailnet listener reads the same policy store, so a desktop's grant holds there. A tailnet connection never asks for the grant: if hello says the desktop may not answer, the desktop waits and writes the grant at its next admin session, and nothing opens SSH silently for it. Tailscale Serve's identity headers are ignored (ADR-0004).

**Desktops stay out of the phones list.** Redeeming a code on the tailnet listener records the client as a phone, so the desktop never does it. The host refuses pairing on the tailnet listener while phone access is off, and while phone access is off and the listener is up for desktops, it refuses a session to a client that paired as a phone.

**The host side.** A new host-local setting, `tailnetConnections`, off by default, is set through a new administrative route over an admin session. Serve runs while phone access or tailnet connections is on, so turning phones off no longer cuts desktops off. Hello gives a desktop client the provider sign-in and client update features and a phone today's list; the handlers check the peer, not the listener. Each listener gets its own observation key, the two share one command receipt map so a retried command survives a move between connections, and tailnet peers count as connected. The listener with the administrative routes is still never served to the tailnet.

**What the owner sees (the delegated picks).**

- **Variant C with A's controls.** Add host's checklist gains a step after Paired, "Reach forge over your tailnet", and its connected card offers **Start forge's host at boot**, one consented press (ADR-0054). A host saved before this gets a one-time line above the list, "forge can connect over your tailnet and start at boot." with **Set up…** and **Dismiss**; Set up opens the same checklist. The row and its menu are variant A's.
- **The row's meta line** begins with how the host is connected: `Tailnet · Connected · 2 providers · Phones on`; `SSH forge · Connected · Tailnet did not answer`, with "Sotto tries it again every 5 minutes." under it; `SSH forge · Connected` when the owner chose SSH; `Connecting over your tailnet…` and then `Connecting over SSH…` while connecting. Reconnecting, off and error lines are unchanged.
- **Edit connection** gains a radio group, **How Sotto connects**: "Over your tailnet, SSH when it can't" (the default) and "SSH only", above the SSH fields, which become a fieldset "SSH (for setup, updates and phones)".
- **The Phones dialog** shows the admin session's approval at its top while that session connects.
- **The tailnet connection is on by default**, for a new host and for an existing host once its host side is set up through the one-time line or Add host.

Each surface is checked at 1600×1000, 1280×800 and 820×560, in light and dark and with reduced motion. The radios move with the arrow keys, each dialog answers Escape, and focus goes back to the control that opened it.

**Privacy.** No new host is contacted. The tailnet address is the same machine, reached over the owner's own tailnet through the Tailscale Serve setting Sotto already owns there, and Funnel is never used. The README's "Privacy and cost" section says so when the connection ships.

## Consequences

- A stolen pairing token now works from anywhere on the owner's tailnet, not only through an SSH session. It still ends only when it is revoked, as today: Forget revokes it, and so does the host's own `--revoke-client`.
- A relaunch, a reconnect and a dropped connection need no SSH and no Tailscale approval while the tailnet answers. Phones, Stop host, Update and Start at boot still ask, because each opens an admin session.
- The 32-peer cap and the pacing on the tailnet listener are shared by phones and desktops.
- On Linux, Serve needs the SSH account to be Tailscale's operator. Until it is, the desktop stays on SSH and the row says why, with `sudo tailscale set --operator=$USER` for the owner to run there. Sotto never runs it.
- Real TLS and MagicDNS cannot run in CI. The tests stand a loopback proxy in front of the host's tailnet listener, and only a check on a real host, recorded in `docs/verification/`, proves the certificate path.
- `docs/host-protocol.md` changes with the host side: the tailnet listener carries desktops, hello reports `tailnetAddress` and `startedBy`, and features are per client.
