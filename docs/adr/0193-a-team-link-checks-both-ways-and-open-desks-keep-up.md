# A team link checks both ways, and open desks keep up

## Status

Accepted November 5, 2026, by Zach's picks on question cards, from the prototype at `~/.sotto/prototypes/teams-look/v2.html`, kept at the tag `prototype/teams-restyle`: look B, desks in Watcher's column, a teammate's desk read every 2 minutes while open, and a check after linking. Part of the Owl feature `teams` (ADR-0072). Amends [ADR-0186](0186-a-team-link-joins-two-owners-computers-over-a-closed-list.md), decisions 5 and 6, and [ADR-0189](0189-two-desks-read-a-teammates-summary-on-a-press.md), decisions 4 and 5.

## Context

Zach and Drake made the first real link on November 5. Zach could read Drake's desk, but Drake's computer could not reach Zach's. Drake's MacBook is on Drake's own tailnet and was shared into Zach's, and Tailscale's sharing goes one way: Zach's computer was never shared back. Nothing told either of them. Drake's read said only that Zach's computer did not answer, and Zach's Teams tab said the link was fine.

Zach also found that setup left steps out, that the desks forgot they were open whenever he went to Watcher and back, and that a teammate's desk had to be read again by hand each time. He wanted the Teams tab to look like the rest of the room, and not blacked out over the scene.

## Decision

**1. A fifth command, `check`, says whether two computers reach each other.** It carries nothing but the token and `back`, which says whether to reach back, and it reads nothing. With `back`, the answering computer first tries to reach the asking one, with a check that does not reach back, and then answers whether it could. So one press learns both directions. It runs no model, makes no **teammate's message** and reaches no Watcher. A computer answers at most 10 checks from one link in any 10 minutes.

**2. The computer that pastes the code checks right after linking.** **Check again** on a link's card checks once more. Each computer keeps the last check's result with the link: whether it reached the teammate's computer, and whether the teammate's computer reached it. The card says **Works both ways**. Otherwise it says which way failed. When the teammate's computer is on another tailnet, it also says what to share in Tailscale and offers **Open Tailscale's Machines**, which opens Tailscale's admin page in the browser.

**3. Setup is six steps on the Teams tab.** Tailscale is on; Tailscale Serve is allowed; your teammate's computer is on your tailnet; share this computer with your teammate; link with a code; check it works both ways. The first and third read this computer's own `tailscale status` when the steps show, and send nothing. The third lists other people's computers by name and says which are shared in from another tailnet. The fourth says that sharing goes one way.

**4. Open desks keep up while they are on screen.** Opening the desks reads the teammate's desk when the last read is older than 2 minutes, and while they stay open it reads again every 2 minutes. It stops when the desks close, when the room shows Watcher, and while the window is hidden. A desk that does not answer is tried again 2 minutes later, not sooner. **Update now** reads at once. Which link's desks are open is kept while Sotto runs, so going to Watcher and back finds them open.

**5. The owner sees the reads, folded.** A teammate's reads less than 5 minutes apart show as one line under **Latest**, such as "Drake read your desk 4 times, from 1:31 PM". The fold below it still lists each kept read.

**6. The Teams tab lies on the room.** It sits in Watcher's column with no ground of its own, as Watcher's conversation does, so the scene shows beside it. Section headings are small, and only a teammate's card keeps a surface. The desks fit the same column, side by side, and have no surfaces or rules.

**7. A link that cannot listen says so on the Teams tab.** When Tailscale is off or Serve is not set up, the owner sees why teammates can't reach this computer and what to do (#2151). Before this, only the teammate saw a failure.

## Options rejected

- **Only explain on failure,** with no new command: Drake's computer would have learned nothing until his first read failed, and the words could only guess at sharing.
- **Reading only on a press,** as ADR-0189 had it: Zach found it annoying in use, and every look at the desks became a press.
- **Reading on every open:** the desks open often, and a read under two minutes old says nothing new.
- **Look A, Settings-style cards,** and desks wider than the column: Zach chose the plain room and the column.

## Failure modes

- **A teammate on an older Sotto.** Its closed list has no `check`, and it answers that it is not on the list. The card says their Sotto is too old to check, and that asks and desks still work.
- **The teammate's computer is off.** A check says this computer couldn't reach theirs, and keeps nothing to send. Open desks try again two minutes later.
- **The window is hidden.** Open desks read nothing until it shows again.
- **Too many checks or reads.** The answering computer turns them down and the card or the desks say to try again in a few minutes. Reading every 2 minutes is 5 of the 10 reads a link may make in 10 minutes.

## Consequences

- ADR-0186's closed list has five commands, and its decision 6 now names a check and open desks among what opens a connection. There is still no heartbeat or presence: nothing goes while the Teams tab is closed or the desks are shut. A check shows whether the other computer answered at that moment, on a press.
- ADR-0189's decision 4 becomes this decision 4: opening the desks reads, and open desks read every 2 minutes.
- `README.md`, `CONTEXT.md` and `docs/guide.md` say so.
- The verification note `docs/verification/teams-link.md` records the built app on seeded links. The real proof is Zach's and Drake's link once Zach's computer is shared back.
