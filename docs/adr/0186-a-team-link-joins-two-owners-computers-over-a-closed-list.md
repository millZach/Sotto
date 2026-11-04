# A team link joins two owners' computers over a closed list

## Status

Accepted by Zach on November 3, 2026, for the first slice of `docs/plans/teams-watchers.md`: "Two Watchers talk, and nothing else." Drake agreed to the plan's default the same day: his computer decides what his Watcher shares, and that is summaries of his own threads. It is an Owl feature (`teams`, ADR-0072). Amends [ADR-0105](0105-hosts-reach-each-other-over-host-links-the-desktop-sets-up.md), which covers only one owner's machines, [ADR-0025](0025-headless-host-and-client-identity.md) and [ADR-0053](0053-a-desktop-reaches-a-host-over-its-tailnet-first.md) on who may be admitted, and [ADR-0152](0152-watchers-room-is-its-conversation.md) on the room's tabs. [ADR-0187](0187-another-owners-words-are-untrusted-and-start-nothing.md) says what a message may do once it arrives.

## Context

Zach and Drake each run Sotto on their own computers and want their Watchers to coordinate: merge priority, and what the other is working on. Every connection Sotto makes today joins one person's own devices. A paired client gets the host service, a host link would get a closed list between machines the owner set up over SSH, and neither fits two owners. Drake has no SSH sign-in on Zach's computers and should not get one, and a paired client can read every thread.

Zach chose direct over a tailnet rather than a relay of Sotto's, which would add a host and an account. He said of traffic: "We need to be very careful with this we don't want to be sending a ton of data back and forth."

## Decision

**1. A team link is a kind of its own, not a paired client.** It has its own listener and its own records, so a team link's token cannot open a host session, reach the host service or list a thread, however the host service changes. A team link is the same shape as a host link with a different owner on the other end: a link adds no grant, and nothing it carries answers anything.

**2. Only a desktop has one.** A team link belongs to the computer that runs the user's Watcher. A headless host has none, and neither do phones. Stable shows and starts none of it, and keeps a saved link's records whole.

**3. Setup is a code, one way, for both directions.** One owner presses **Make a code** on the Teams tab and sends the code to the other however they like. It holds their computer's tailnet name and port and a pairing code, works once, for 30 minutes rather than pairing's 5, because it goes between two people rather than across one desk. Five wrong tries end it. The other owner pastes it and presses **Link**. That one exchange gives each computer a token for the other, so neither has to do it again the other way. The joining computer turns its own listener on before it redeems the code. A code that names anything but an `https://` address under `.ts.net` is refused before anything is contacted, so a pasted code cannot point Sotto at any other host.

**4. The listener is tailnet-only.** Main listens on a loopback port, and Tailscale Serve carries HTTPS port 8445 to it, on the tailnet and never on Funnel, or another port when something already holds that one. It runs only while a code waits or a link exists, and Sotto takes its Serve setting off when the last link goes. Two owners on different tailnets each share their computer with the other through Tailscale's own device sharing. Shared machines can only start connections when the sharing goes both ways, and are reached by their full `*.ts.net` name. Sotto does neither of those for them and contacts no new service for it. A link that cannot listen yet, as when Sotto starts at login before Tailscale connects, asks this computer's own Tailscale every 30 seconds until it can. That reaches no one else, so decision 6 holds.

**5. The list is closed, with three commands.** ([ADR-0189](0189-two-desks-read-a-teammates-summary-on-a-press.md) adds a fourth, `read-desk`, which a press sends.) `POST /teams/v1` takes one strictly parsed message:

- `redeem-code`: a code, this computer's name, its address and a token for it. The only command with no token.
- `ask`: one of the two asks, with the asker's words, at most 800 characters. Its answer comes back in the same response.
- `link-again`: this owner wants the link kept (decision 7).

Anything else is refused without being read further, including every host command, however well signed. Bodies are capped at 16 KB. There is no command that lists threads, reads history, starts, stops, sends, settles, approves or merges, so a later slice that wants one adds it here on purpose.

**6. Nothing goes without a press or an ask.** There is no heartbeat, no presence, no polling of a teammate and no retried send. Only an ask, a redeemed code, **Link again** or **Get Drake's desk** (ADR-0189) opens a connection, so the Teams tab and Settings > Hosts & phones show when each link was last used and never whether the other computer is online. This replaces the first prototype's "online" and "Watcher ready".

**7. A link lasts 30 days, and both owners renew it.** After 30 days a token is good only for `link-again`, and the receiving computer starts nothing for it. **Link again** tells the other computer this owner wants the link kept. When both have pressed within 7 days, both renew it for 30 more. Removing a link removes it here and sends nothing; the other computer finds out when its next ask is refused, and says so. This covers team links only. The wider token expiry of #1692 stays its own ADR and pull request (plan, open question 10).

**8. Tokens are kept as other secrets are.** A token this computer accepts is kept only as a hash, in `PairedClients` over a folder of its own. A token this computer sends is kept in the credential store. A code, a token and a message's words never reach a log; main logs stable event names only.

**9. Teams is a tab beside Watcher.** Zach's pick on November 3, A of the placement prototype (`prototype/teams-placement`): the header holds **Watcher** and **Teams** tabs after the tile while the feature is on. This amends ADR-0152 decision 1, which removed the room's tabs, for Owl only and for this one tab; with the feature off the header is as ADR-0152 left it. The tab links, renews and removes links, keeps the leave-out list, and shows the latest asks and answers. The asks and answers themselves show in Watcher's conversation. Two desks and the merge order strip (plan, decision 9) are the next slice, also Zach's pick.

**10. The owner decides what a summary covers.** Every project is in by default, as Drake agreed. The Teams tab lists this computer's projects and the projects of its connected hosts so the owner can leave any out, and a left-out project's threads never reach the writer of an answer (ADR-0187).

## Options rejected

- **A paired client with fewer commands.** A paired client's token opens the host service, and a closed list on top of that is a list of refusals that every new host feature has to remember. A separate listener has nothing to refuse.
- **Host links' setup over SSH.** It would give each owner an SSH sign-in on the other's computer.
- **A relay of Sotto's.** Zach chose direct. A relay adds a host and an account.
- **A socket held open between the two computers.** It would give an online dot and carry traffic nobody asked for.

## Failure modes

- **The other computer is off, asleep or unreachable.** The ask fails at once, nothing is kept to send later, and the row says so and what to do next.
- **Sotto restarts while an ask waits.** The answer is lost with the response, and the row says it did not come back. The other computer's Teams tab still shows what it answered.
- **Tailscale Serve is off for the tailnet, or this account cannot change it.** **Make a code** and **Link** say so with what to do, as phone access does, and nothing is linked.
- **The other owner never presses Link again.** The link stays expired, and an ask says so. Nothing is removed.

## Consequences

- `README.md`'s "Privacy and cost" names a teammate's computer as a host Sotto contacts, with its reason.
- A teammate on the tailnet can reach the listener's port, but it does nothing without a token or a live code.
- `src/main/teams/` holds this, and imports nothing from the host protocol's command path.

## Proof

Integration tests over two real listeners on loopback, with Tailscale stood in for: linking both directions from one code, a used, wrong, old or foreign-address code refused, a burned code after five tries, every `AgentCommand` type and an unknown command refused with a good token and no handler called, an expired token refused for `ask` and taken for `link-again`, and renewal only when both pressed. A count test holds that nothing is sent without a press or an ask. A real pair of computers is recorded in `docs/verification/`.
