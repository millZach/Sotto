# Apps on this computer connect without a pairing code

## Status

Accepted November 2, 2026, at Drake's ask: Agent Popup, his own menu bar app for Claude, Codex and Sotto, should "direct-connect with Sotto" instead of being paired through the phone settings with a code. Asked whether such an app may answer question and permission cards, he chose that it may. An **Owl feature** (`local-apps`, ADR-0072). **Number provisional until merge** (docs/agents/domain.md).

## Context

An app on the same computer can reach Sotto's threads today only as a phone: the owner turns on **Let phones connect**, which needs Tailscale running and Serve turned on, shows a pairing code, and types it into the app. Agent Popup did exactly this (`~/Developer/agent-popup`, which grew out of Sotto Popup). The code proves that the person at the phone is the person at the desktop. On one computer under one user account, that proof adds nothing that the user's own account does not already give, and the Tailscale requirement is there only for the tailnet, which a loopback client never touches.

The options considered:

1. **Keep pairing.** Rejected: it is the friction Drake asked to remove, and it ties a loopback client to Tailscale.
2. **Ask in Sotto once, on the first connection.** A card in Sotto offers to let the app in. Rejected for now: it is more to build, and a loopback caller cannot be told apart from any other process under the same user, so the card would vouch for nothing more than the file below does.
3. **A switch and a token file only this user can read.** Chosen.

## Decision

1. **The switch.** **Let apps on this computer connect** (`localApps`, off by default) in Settings → Hosts & phones, under phone access. It applies at once and needs the local host. Its words say what it gives: apps on this computer can read and send to your threads and Watcher, and answer questions and permissions, without a pairing code.
2. **Its own listener.** While the switch is on and the local host runs, main starts the host protocol listener (`startSocketServer`) a second time over the desktop's own host service, on `127.0.0.1` only, with the same features a phone's listener offers. Phone access and Tailscale are not needed and are never touched. It has its own pairing store, `local-apps/paired-clients.json` in the user data folder, so the client never shows on the Phones page or counts as a phone.
3. **One client, minted by the switch.** Turning the switch on pairs one client named **Apps on this computer** in that store, without a code, and writes the remote-answer policy record for it (ADR-0004), since the user chose that these apps may answer. Turning the switch off revokes the client and its record, closes its sockets and deletes the file below. Each start keeps the same client and token while the switch stays on.
4. **The file.** `local-apps.json` in the user data folder (`~/Library/Application Support/sotto/` on macOS, `%APPDATA%\sotto\` on Windows, `~/.config/sotto/` on Linux), written atomically with mode 0600:

   ```json
   { "version": 1, "port": 54321, "token": "…", "clientId": "…" }
   ```

   `port` is the loopback listener's port, tried first again at the next start. `token` is the bearer for `POST /v1/session`, exactly as a pairing would return it; the pairing store keeps only its hash. The file exists only while the switch is on. An app reads it, checks `/v1/health`, opens a session with the token and then speaks host protocol v1 as a phone does. A 401 means the switch was turned off and on again, which mints a new token: read the file again.
5. **What is logged.** Stable event names only, never the token, the port or the client ID.

## Consequences

Any process running as this user can read the file and drive Sotto's threads, including approving permissions. That is the same trust as Sotto's own data folder, which already holds every transcript, and it is why the switch is off by default and says so. Nothing listens beyond this computer, and no host is added. Pairing stays for phones, and for any app the owner would rather pair by code.
