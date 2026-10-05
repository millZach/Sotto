# A host's phone access is turned on from the desktop

## Status

Accepted October 4, 2026, by the owner's choice of variant B, "Dialog from the row", in `docs/prototypes/host-phone-access-prototype.html`. The owner asked for it after the iPhone could not add forge, a host with no monitor: the error said to turn on phone access in Settings > Phones on forge, which nobody can open there. They chose a switch per host over relaying every host's threads through the main computer, the host's pairing code and paired phones shown on this computer, Sotto saying plainly when Tailscale is missing or Serve is off on the host rather than installing anything, and the iPhone's Add computer naming this route. Amends [ADR-0033](0033-the-desktop-lets-paired-phones-reach-its-threads.md), which said the headless host sends no name, and [ADR-0025](0025-headless-host-and-client-identity.md).

## October 5 amendment: the tailnet listener carries desktops, and a host can start at boot

[ADR-0053](0053-a-desktop-reaches-a-host-over-its-tailnet-first.md) and [ADR-0054](0054-a-host-can-start-at-boot-on-linux.md), accepted October 5, 2026 as the owner's delegated picks, change three things here.

- **The phone listener is now the tailnet listener** and carries a paired desktop's connection as well as phones. A new host-local setting, `tailnetConnections`, off by default, keeps Serve on for desktops, so Serve runs while either it or `phoneAccess` is on, and turning phones off no longer cuts desktops off. Hello's features are chosen per client: a desktop gets provider sign-in and client updates, a phone today's list. While phone access is off, the host refuses pairing on that listener and refuses a session to a client that paired as a phone. The listener with the administrative routes is still never served to the tailnet, as the decision says.
- **The administrative token lives in an admin session**, not in one long connection. The launch script still hands it back over SSH, and the desktop keeps it in memory only for that SSH connection, which closes 60 seconds after its last use. The Phones dialog holds one open while it is open, and shows Tailscale's approval at its top while that session waits for one.
- **The first consequence below no longer holds on Linux.** A host can start at boot from a systemd user unit, so its phones reach it after its machine restarts with no desktop connecting. On macOS and Windows hosts it still holds.

## Context

ADR-0033 lets the desktop serve its own threads to paired phones through Tailscale Serve. A headless host already speaks the same protocol, and the guide told its owner to point Tailscale Serve at the host's loopback port. That did not hold up. A host the desktop starts over SSH listens on a port chosen at each start, so a Serve setting made by hand stops working at the next restart. A phone's pairing code came only from the host's command line. And most hosts that run threads have no screen, so every step meant signing in to the machine.

The options considered:

1. **Relay through the main computer.** The desktop serves its remote hosts' threads too, so a phone pairs once. Rejected: forge would be reachable only while the main computer is awake and connected to it, and every thread's content would pass through a second machine. It would also reverse ADR-0033's rule that each computer shares only its own threads.
2. **The host runs phone access itself, turned on from the desktop.** Chosen.
3. **Guide the owner through the host's own command line.** Rejected: it is the same set of steps the owner could not do, written down.

## Decision

A headless host listening for clients runs the desktop's own phone access (`PhoneAccess`, ADR-0033) over its host service: a loopback listener of its own, on a port it remembers in `phone-access.json` in its data folder, and Sotto's Serve setting on HTTPS port 8443 pointing at it. Port 443 is left alone and Funnel is never used, as on the desktop. The `phoneAccess` setting is the host's own, so the host puts Serve back each time it starts and takes it away when it stops, the way the desktop does when it quits. The host's other listener, the one with the administrative routes that the desktop reaches through SSH, stays on loopback and is never served to the tailnet.

The host shares its one pairing store between the two listeners, so a phone pairs into the same clients a desktop does. Phone access records which clients paired through it, in `phone-clients.json`. Only those are phones: the desktops paired with the same host are never listed as phones and can never be removed from the Phones dialog. Health on the phone listener carries the host's name on the tailnet, so phones list its threads under `forge` (amending ADR-0033, which said the headless host sends no name).

The desktop administers it. Settings > Hosts gives each connected host a **Phones…** button and a few words at the end of its row (Phones off, Phones starting…, Phones on and how many are paired, or Phones need you). The button opens a **Phones on forge** dialog holding the switch, **Let phones reach forge**, the same three checks the Phones page shows (Tailscale on the host, Serve on 8443, the address), **Pair a phone** with the host's code, and the host's paired phones, each with **Can answer** and **Remove**. Can answer writes the phone's `remote-answer` policy record on the host, as the host's own `--allow-answers` does; the switch is still the only thing that writes one (ADR-0004).

The dialog reaches the host through the host's administrative routes, `/v1/admin/phones` and `/v1/admin/phones-command`, on the port the SSH connection already forwards, with the host's administrative token. The launch script reads that token from the host's listener descriptor and hands it back with its launch result, on the SSH session's own output, so no second SSH sign-in is needed. The desktop keeps the token in memory for that one connection and never writes it down or logs it. The SSH account could read the descriptor already, so this gives the desktop nothing that account did not have.

The desktop reads a host's phone access once when it connects, for the row, and again every two seconds while the host is still starting it. While the dialog is open it reads again every two seconds, so a phone that pairs or connects shows up there. The dialog says it is still open every 30 seconds, and a watch nobody renews ends after a minute, so a closed window stops the reads. When Tailscale's consent page is the next step, the host hands its address back and the desktop opens it on this computer, on the owner's press, only if it is one of Tailscale's own pages.

Sotto installs nothing on the host. When Tailscale is missing there, or not signed in, the first check says so. When Tailscale refuses the SSH account the right to change Serve, as Linux does until the account is its operator, the second check says so and shows `sudo tailscale set --operator=$USER` for the owner to run there, with a button to copy it. Sotto never runs it.

## Consequences

- A host's threads are reachable from phones only while its host runs. A host Sotto started keeps running until it is stopped, but after the machine restarts it starts again only when a desktop connects to it. Running the host as a service is a separate piece of work.
- One more listener runs on a host while phone access is on, on loopback only. Everything that reaches it comes through Tailscale Serve on the owner's tailnet, then through pairing and signed sessions, exactly as on the desktop. The remote command list in ADR-0025 applies unchanged.
- The host's administrative token now crosses SSH to the desktop. It stays in the desktop's memory for one connection and authorises only what the account's SSH session could already do on that machine.
- Phones paired from the host's own `--pairing-code` command before this are not in `phone-clients.json`, so the dialog does not list them. They stay paired, and the host's `--allow-answers` and `--revoke-client` commands still reach them.
- Tailscale's CLI runs on the host only once the owner turns phone access on there. A host whose setting was never turned on never runs it.
