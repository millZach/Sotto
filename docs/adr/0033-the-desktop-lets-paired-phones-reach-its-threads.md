# The desktop lets paired phones reach its threads

## Status

Accepted September 26, 2026, by the owner's choice of variant C, "Guided setup", in `docs/prototypes/phone-access-prototype.html`. Amends [ADR-0025](0025-headless-host-and-client-identity.md), which said the desktop adds no production listener. Amended by [ADR-0050](0050-a-hosts-phone-access-is-turned-on-from-the-desktop.md): a headless host now runs the same phone access, turned on from the desktop's Hosts page, and sends its name on the tailnet.

## Context

The iPhone app (#225) speaks host protocol v1 to a host: health, pair, session, revoke and the socket. Until now only a headless host opened that listener, so a phone could reach threads only on a machine that ran one. Most of the owner's threads run in the desktop app's own local host, on the computer in front of them. T3 Code solves the same problem by letting its desktop app serve its own threads to its phone app over the owner's tailnet.

The options considered:

1. **Headless host only, on each computer.** Keep the desktop without a listener and ask the owner to run a headless host beside it for the phone. Rejected: the headless host has its own data folder and its own threads, so the phone would see a second set of threads rather than the ones on screen, and every computer would need a second process set up by hand.
2. **The desktop's own listener, reached through Tailscale Serve.** Chosen. The desktop opens the same socket server the headless host uses, over its own host service, and asks Tailscale Serve on this computer to carry it to the tailnet.
3. **A relay.** A Sotto service both sides connect out to. Rejected: it adds a host every thread's content would pass through, an account to run it, and a party the README would have to name; Tailscale already gives a private, authenticated route between the owner's own devices.

## Decision

**Phone access** is a setting, `phoneAccess`, off by default, with a Phones page in Settings after Hosts. It applies at once, without a restart. It needs the local host, since what it serves is the local host's threads; with the local host off, the page says so and offers to go to Hosts.

While it is on, main starts the host protocol listener (`startSocketServer`) over the desktop's own `hostService`, so a phone sees exactly the threads this window's local host shows, and never a remote host's. Each computer shares only its own threads; a phone paired with several computers merges them itself. The listener binds `127.0.0.1` only, on a loopback port Sotto remembers in `phone-access.json` in the user data folder and falls back from when it is taken. Paired phones are kept in `paired-clients.json` in the same folder, through the same `PairedClients` store the headless host uses.

Sotto runs Tailscale Serve itself: `tailscale serve --bg --https=8443 http://127.0.0.1:<port>`. That is tailnet only; Sotto never runs Funnel. Port 443 is left alone, because other apps use it (T3 Code does on the development machine). The CLI is found without a shell, on the PATH, then at `%ProgramFiles%\Tailscale\tailscale.exe` on Windows or inside `/Applications/Tailscale.app` on macOS, and every call is `execFile` with an argument array and a timeout. `tailscale status --json` gives the checklist's first row and the address, and `tailscale serve status --json` says who holds 8443. Sotto changes only a setting that is its own: one HTTPS proxy at `/` to one of its loopback ports, with Funnel off. Anything else on 8443 is left as it is, and the page says another app uses the port. When the tailnet has not turned Serve on, the CLI prints a consent page on `login.tailscale.com`; Sotto stops there, says so plainly, and opens that page only when the owner presses the button for it. The CLI talks to the local Tailscale service, so Sotto contacts no new host.

Turning phone access off closes the host protocol listener and with it every phone’s socket, and removes Sotto’s 8443 setting. If removal cannot finish, Sotto reserves the loopback port with a placeholder that immediately closes connections, reports that phones cannot connect while cleanup finishes, and retries every 30 seconds while open. At start, pending cleanup reserves the saved port in the same way. An unreadable record keeps cleanup pending while an occupied mapping cannot be identified as Sotto’s; another app’s mapping is never removed. A corrupt primary stays in place until an atomic write replaces it with a pending-cleanup marker; each uncertain cleanup attempt retries that write after a successful read. An I/O failure preserves the primary and retries reading it. Quitting makes a bounded cleanup attempt; the next start finishes it. Sotto must successfully save its record before asking for the setting; if the write fails, it refuses setup and closes the new listener. It records that it asked for the setting before asking, and clears the record once the setting is gone, so a crash's leftover is removed at the next start even with phone access off. With the setting never used, Sotto never runs the CLI.

Pairing codes are issued only from the Phones page: one live code at a time, eight characters, good once for five minutes, held in memory and never logged. Showing a new code or cancelling withdraws the old one, and a phone redeeming it closes the card and lists the phone. The listener's administrative routes are off on the desktop: it administers the listener in-process through IPC to the main window, so no admin token exists on disk or reaches the tailnet. Health gains an optional `name`, the computer's name as phones show it, from the setting `phoneAccessName` or, when that is empty, the Tailscale machine name or the computer's own. The headless host sends no name.

A paired phone reads threads and replies. Its answers to questions and permissions count only after the owner turns on **Can answer** for it on the Phones page, which writes the `remote-answer` policy record scoped to that phone (ADR-0004); the switch is the only thing that writes one, and turning it off revokes it. **Remove** asks first, then revokes the pairing, revokes any such record, and closes the phone's sockets at once. The headless host's own allow and deny commands and the Phones page now share one helper, `PolicyStore.setRemoteAnswers`, so a client never holds two records that disagree.

## Paired clients may choose reasoning (September 30, 2026)

The owner decided in #609 that pairing also lets a phone change the coordinator's `reasoning` provider and `reasoningModel`, without **Can answer**. These choices can send assignment text and relevant thread context to a different reasoning host named in the README's Privacy and cost section, using credentials already saved on the computer. Pairing therefore trusts the phone to choose where coordinator reasoning runs, as well as to read threads and send replies. This records the existing remote configuration allow-list; it adds no command or destination.

This choice grants no permission to an agent and writes no policy record. Answers to questions and permissions still require the phone's `remote-answer` policy (ADR-0004). Credentials, endpoints and the voice engine stay host-local; a paired phone cannot supply a key or an arbitrary reasoning endpoint.

## Consequences

- The desktop now has a production listener, on loopback only, while phone access is on. Everything that reaches it comes through Tailscale Serve on the owner's tailnet and then through pairing and signed sessions; nothing outside the tailnet can reach it, and nothing on the tailnet can do more than a paired client may (the remote command list in ADR-0025 applies unchanged).
- Thread content, and the replies a phone sends, travel to the owner's paired phones over their tailnet. The README's "Privacy and cost" section says so.
- Tailscale often starts after Sotto at sign-in. When Tailscale is not running, the page says so and Sotto looks again every 30 seconds while phone access is on, besides the Try again button.
- The switch shows the setting, not whether the last attempt worked: a failed step is shown on its own row with what to do, and the owner does not have to turn the switch off and on again. The prototype drew the switch off in those states; keeping the setting on is what lets a reboot race with Tailscale recover by itself.
- A second desktop on the same tailnet can do the same on its own computer; each serves its own threads on its own 8443.

## October 1 amendment: slow connections and recovery

Only the phone initiates keep-alive pings on its connection, every 25 seconds. A pong, any received message, or growth in received bytes within ten seconds confirms liveness, including a large frame still arriving. The listener answers pings, counts all incoming bytes as progress and closes a silent peer after 75 seconds only when output is no longer buffered. This avoids cutting off slow thread downloads while still releasing abandoned connections.

The active phone reconnects with exponential waits from about one second to a thirty-second cap, with a small random variation (0.8–1.2 before the cap). Hello does not reset the delay; the first successful liveness round does. Reconnect reads threads and reconciles receipts without sending an unconfirmed command again. Backgrounding cancels retries. Physical-device network changes remain a separate verification from simulator tests.

## October 1 amendment: older idle clients

Client-owned pings require `client-liveness` in hello's `accepts`, an additive v1 feature. Only opted-in peers get the 75-second idle close, deferred while output is buffered. Older clients keep host pings every 25 seconds; a missed pong closes them only when no other traffic arrived and no output remains buffered. Their WebSocket implementations can answer host pings while the app is idle. This replaces the earlier listener-only-answer rule for clients without the opt-in.

## October 1 amendment: phone reads on slow links

The phone no longer relies on the WebSocket task's byte counter. Each ten-second liveness round checks completed messages and pong replies, and closes only after two consecutive silent rounds. A request still awaiting its reply within its own deadline prevents silence from accumulating. Detail and observe reads have 120-second deadlines; other requests retain 30 seconds. A connection with no requests closes at the second round, about 60 seconds after opening; an unanswered detail expires at 120 seconds and cannot protect a dead connection indefinitely. Only an actual message or pong resets reconnect backoff. This replaces the earlier byte-progress rule.

## October 2 amendment: late pongs and drained tunnel writes

Both host pings for older clients and Node desktop-client pings require two consecutive silent rounds. Any received bytes reset silence. Frames written since the previous ping or output still buffered prevent a round from being silent, because loopback tunnels can drain Node's buffer before the peer receives the frames. The heartbeat's own ping never renews progress. A completely silent peer closes at 75 seconds; after final incoming traffic or a drained application write, it closes within 75 seconds. Opted-in listener peers count outgoing frames too and close within 100 seconds of the last progress once output drains. Continuing traffic and buffered output defer those bounds.

The phone also accepts growth in URLSession's received-byte counter as progress, sampled across rounds. This supplements rather than replaces pending-read protection: partial-frame counter updates are not guaranteed. An unrequested slow push without counter updates remains a real-device verification limitation. This amends the October 1 silence rules without changing protocol fields, permission authority or reconnect replay behavior.

## Amendment, October 3, 2026: a command still being carried out reads as sending

The phone marked every reply, answer and stop unconfirmed from the press until the computer answered, so a normal send showed a warning that asked the user to check the thread. A command now reads as sending while its request is on its way. When the thirty-second acknowledgement deadline passes, the phone reads the command's receipt, which it already reconciles on reconnect: `pending` means the computer has the command and is still carrying it out, typically a provider starting up, so it stays sending and the receipt is read again every two seconds, 300 times at most, about ten minutes. A completed receipt is settled as before; `unknown`, a changed connection or the last read leave it unconfirmed, with Check again. Each command's receipt has one reader per connection, and a newer connection takes over from an older one. A reconnect that finds a receipt still pending reads it the same way. Thread and project creation keep their own sheet and are not followed. Nothing is ever sent again: the receipt is evidence of delivery, never a reason to resend.
