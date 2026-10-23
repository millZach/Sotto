# Hosts reach each other over host links the desktop sets up

## Status

Accepted by Zach on October 23, 2026, on the question card: the desktop relays first, and host links come once a Mac is connected. What he accepted is the record as a whole, with the operations defined once on the host socket and the desktop as their first caller (decision 1). Host links themselves (decisions 2 to 5, 10 and 11) are built later, once a Mac is connected; until then no host holds a link, and nothing below that needs one exists. The first operation built is sending a branch (decision 8), with #1033: the desktop moves a branch to or from a host it is connected to, and receipts are its only surface (`docs/host-protocol.md`, "Branch moves"). One move carries at most 256 MiB (Zach, October 23).

Proposed October 21, 2026, for Zach's decision. It answers his question of October 21: with three or more computers on one tailnet, why can't the hosts talk to each other without the laptop? Nothing technical stops it; Sotto was built desktop-first. The research and the build order are in `docs/research/2026-10-22-cross-machine-placement-and-delegation.md`. On October 22 Zach picked the order this record recommends (the desktop relay first, then host links once a Mac is connected) and link-start on by default (decision 5). The record as a whole is still his to accept.

It would amend [ADR-0082](0082-work-moves-between-a-desktops-machines-over-its-own-ssh-link.md) (how a branch travels, and a snapshot for test runs), [ADR-0081](0081-a-thread-may-delegate-work-to-threads-it-starts.md) decision 10 (a thread on another machine may delegate), [ADR-0053](0053-a-desktop-reaches-a-host-over-its-tailnet-first.md) (a host's tailnet listener admits a third kind of client) and [ADR-0025](0025-headless-host-and-client-identity.md)'s closed list of what a paired client may send. It keeps [ADR-0088](0088-sotto-leans-on-tailscale.md)'s rule of no relay server and [ADR-0004](0004-authority-in-policy-records.md) whole. It would be an Owl feature ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)); stable shows and starts none of it.

Zach's settled decisions that this builds on (October 21): a parent may run on any machine and coordinate children on any other; moves refuse uncommitted work, and a test run snapshots it instead; a move hands over with the fixed handover plus a facts block Sotto writes; rebalancing only suggests; one full test suite per machine at a time; no per-machine limits; sends to a thread wider than the new-thread default are allowed (#1145).

## Context

Every connection Sotto makes between machines starts at the desktop. The desktop holds the saved hosts, their SSH targets and identity files, each host's pairing token, the Settings every start is held to, and Watcher. A host knows its own threads and its paired clients, and nothing about any other host.

That made sense with one laptop and one forge. It stops working for what Zach now wants:

- **The laptop sleeps.** With the lid closed, nothing can move between forge and a Mac, and a parent thread on forge cannot start a child anywhere else.
- **Forge to a Mac has no path.** ADR-0082 moves a branch between the desktop and one host. Forge to a Mac would go through the laptop's clone, with two transfers and two SSH sign-ins.
- **Each move signs in over SSH.** ADR-0082 opens a fresh SSH session per move. On a tailnet whose Tailscale SSH policy is in `check` mode, as Zach's is (ADR-0025, September 27 amendment), a move started at night waits for a browser approval nobody gives.
- **A thread on another machine gets none of Sotto's tools** (`NOT_ADMITTED`, `src/main/agents/delegation.ts`; `src/host/index.ts`: "A host starts no delegation itself").

Each host already has what a host link needs. Since ADR-0053, a host Sotto added serves its **tailnet listener** through Tailscale Serve, over HTTPS with a real certificate on its `*.ts.net` name, and admits paired clients by token. A host is already a client of nothing, but nothing stops it being one.

The options considered:

1. **The desktop relays everything.** Hosts never learn of each other. A branch from forge to the Mac goes forge to desktop to Mac over the two connections the desktop already keeps, and a remote parent's delegation goes to the desktop, which starts the child. No new trust between hosts and no tailnet policy change. But it all stops when the laptop sleeps, every byte crosses the laptop twice, and the laptop's main process carries the traffic of machines it is not part of, which #1089 already shows is costly.
2. **Hosts sign in to each other over SSH.** Rejected: every host would hold an identity file for every other, and `check` mode would hold those sign-ins too.
3. **Admit another host on its Tailscale identity.** Rejected, as ADR-0053 rejected it for desktops: a tailnet identity names a node or a user, not a client the owner paired, and only a policy record grants authority (ADR-0004). It may be used as evidence that narrows (decision 3).
4. **A relay server of Sotto's.** Rejected by ADR-0088.
5. **The desktop sets up a link once, with the owner's press, and the hosts then talk over each other's tailnet listener.** Proposed.

## Decision

**1. One set of operations, two callers.** Sending a branch, starting and driving a delegated thread on another machine, and moving a thread are each defined once, as host protocol requests behind optional host-v1 features. The desktop is their first caller, relaying between hosts it is connected to (option 1). A host that holds a **host link** is the second, for the same requests, with a narrower allow-list. So option 1 is built first and option 5 adds a caller rather than a second design, and each stage works on its own.

**2. Names.** A **host link** is a one-way pairing that lets one host reach another host's tailnet listener as a client: "forge's link to the Mac". It is the owner's, set up from the desktop. The machine a link reaches knows the other as a **linked machine**, a client kind of its own beside desktops and phones. Links are always made in pairs, one each way, by one press, so the owner thinks of "forge and the Mac can reach each other". `CONTEXT.md` gains both entries when this is accepted. Avoid "peer", "mesh" and "direct", which `CONTEXT.md` already warns off for the tailnet connection.

**3. Setting a link up.** The desktop brokers it once, while it is connected to both hosts, on the owner's press. It is never set up on a timer, by an agent, or by a host on its own.

- **Where it is offered.** When a second remote host is connected, Settings › Hosts offers "Let forge and the Mac reach each other". Add host for a third machine offers it on its connected card. A prototype comes first (the research note says what it must show).
- **The code.** Over the Mac's SSH or admin connection, the desktop asks the Mac's launch script for a **link code**: single use, five minutes, bound to forge's host ID and forge's tailnet node name as the desktop's `tailscale status` gives it. It travels on SSH stdout into the desktop's memory and from there on SSH stdin to forge's launch script, with the Mac's host ID and tailnet address. It is never sent on a listener, written to a file or logged.
- **The redemption.** Forge redeems the code at the Mac's tailnet address, on a new `POST /v1/link` route of the tailnet listener that takes only link codes, never a phone's. The Mac checks the code and the host ID it is bound to. As evidence that can only refuse, the Mac asks its own Tailscale who the connecting node is (its local API's `whois`) and refuses when it is not the node the code names. The Mac answers with its host ID, a client ID and a token; forge checks the host ID is the one the desktop gave it.
- **Who records what.** The Mac records forge as a linked machine itself, at the redemption of a code its own administrative route made, so the kind is written by the Mac from the owner's SSH session, never claimed by the client, as `desktop-clients.json` is (ADR-0053). Forge keeps the Mac's host ID, tailnet address and token with the protection the host gives its other secrets. Then the same is done the other way.
- **The test.** Forge opens a session to the Mac at once and reports back. The desktop says "Forge and the Mac can reach each other", or, for example, "Forge cannot reach the Mac over your tailnet. Your tailnet policy may not let forge reach the Mac on port 8443. Nothing was changed on either machine." with the rule to add (decision 11), and removes the half-made link.

**4. What a linked machine may ask.** A closed list, as for every client kind (`src/host/remoteCommands.ts`), and only threads it started through the link:

- **Send a branch** into `refs/sotto/incoming/<move>/<branch>` (decision 8). A link only sends; it never fetches. When forge needs the Mac's work, forge asks and the Mac sends, under the Mac's own record. So a link cannot pull another machine's refs. It can still have a thread it starts read a shared project's files and report them in its reply, as decision 5 and the Consequences say; that reach is the thread's permission's, not the link's.
- **Start a delegated thread** for a parent on its own machine, in a project the receiving machine matches by GitHub origin, and send it briefs, read its outcome, stop it and settle it.
- **Offer a move** of one of its own threads (decision 7), and answer for its side of one.
- **Read the receiving machine's host facts** and how many threads it has working.

Nothing else: no thread it did not start, no history but its children's replies as `read_delegation` cuts them, no answers, no policy, no Files, Changes, terminals or previews, no Watcher control, no phones, no updates, no administrative route and no credentials. A link never reaches the desktop.

**5. Authority and the ceiling.** A link adds no grant.

- A thread a linked machine starts is held to Ask for approval, unless the receiving machine holds a **link-start** policy record for that link, scoped `client:<clientId>`. Only the launch script writes one, over SSH, on the owner's press during setup ("Let forge start threads on the Mac that act without asking, up to your new-thread default"), the way the desktop's `remote-answer` grant is written (ADR-0025, September 29 amendment). Zach chose on October 22 that it is offered, and on by default, with its sentence on the press.
- Even then, the start is capped by the desktop's new-thread default as the desktop last told that machine. The desktop sends each host it connects to its new-thread default and its worker roles (ADR-0091), when it connects and when Settings change, as **desktop defaults** the host keeps with their time. A host never told holds every linked start to Ask for approval. A linked machine's claim about its parent's permission can only narrow the start, never widen it, since a linked machine can lie.
- A delegated thread's questions and permission requests reach the user on their own cards, on the desktop and the phone. The parent is told only that the child is waiting. Nothing a linked machine sends answers anything.

**6. A thread on another machine may delegate (amends ADR-0081 decision 10).**

- **Its own machine first.** A host builds the delegation service and the tool server for its own threads (`runtime.ts` stops skipping them on a headless host), on its own loopback, with its own tokens. A child on the parent's machine needs nothing from another machine, but needs the desktop defaults (decision 5).
- **Another machine.** `delegate` takes a machine. A linked machine is reached over the link; This computer is reached over the connection the desktop already keeps to that host, through a push the desktop accepts in hello and answers under the same rules, and only while the desktop is connected. Otherwise `delegate` refuses: "The laptop isn't connected, so nothing can start there now. Nothing was started."
- **Outcomes.** The receiving machine keeps the child's record, pushes outcome changes to the parent's machine over the link, and answers exact reads. The parent's machine turns each change into the parent's hidden wake-up, with an answered child's reply, as ADR-0081's October 19 amendment does today. After a dropped link, the parent's machine reads every open delegation's outcome exactly; one it cannot prove stays `unknown`, and nothing is sent again (ADR-0058).
- **Stop and settle** cascade over the link. When the link is down, Stop on the parent says which children it could not reach, and the desktop, which is connected to every machine, can stop them from their own rows.
- **The roster.** The parent's Tools › Agents lists children on any machine, joined by the desktop's host router by host ID and Sotto thread ID, each with its machine named. A prototype update comes first.

**7. Moving a thread between hosts.** A move is "continue on another machine" ([ADR-0089](0089-a-thread-continues-on-another-provider-as-a-new-linked-thread.md)): a new thread with its own Sotto thread ID, never a moved session.

- **The record.** Both machines keep a move record, keyed by the move's ID and written before anything is sent, with states: fenced, branch sent, thread started, first turn ended, source settled, or given back. Each step is idempotent by the move's ID, so a retry returns the thread a first try made and never makes a second.
- **The order.** The source is fenced first: it refuses sends while the move runs. The branch goes (decision 8). The handover and the facts block are built on the source machine, where the thread's history lives, and the target starts the new thread with them. The source is settled once the target confirms the new thread's first turn; its worktree stays until that turn ends, and no automatic cleanup runs on it while #1297 is open.
- **What blocks a move.** A turn running, a question or permission card, background work, an unresolved send, uncommitted work, a delegating thread with children still working, any delegated thread, and Watcher's own thread. Each is refused in plain words before anything moves.
- **Narrower on arrival.** When the target would start the thread narrower than it runs now, or without a GitHub sign-in its babysitting needs, the move says so and waits for the owner's press.
- **Reconciling.** After a restart or a dropped link, the two machines read each other's record exactly. A target that holds a thread for the move confirms it; one that does not records a fence against the move's ID before it says so, the way Watcher's `OPERATION_NOT_RECORDED` does, so a late start can never land. Only that negative answer unfences the source. Anything else leaves it fenced, and the desktop says "This thread is waiting for the Mac to answer about its move. Nothing was lost." with **Keep it here**. Keep it here asks the target to fence the move and to stop and settle any thread it made for it. The source is unfenced only once the target answers that it holds no thread for the move, or that it stopped and settled the one it had. While the target cannot be reached, the source stays fenced and says so, because a target whose answer was lost may already be running the new thread.
- **Watch and babysitting.** Watches are the desktop's (Watcher lives there). The desktop re-points a watch, in one record write, when it next reads a confirmed move, and the receipt says so. Babysitting starts on the target for the same pull request and ends on the source when it settles.

**8. How a branch travels (amends ADR-0082 decision 5, and decision 1 for test runs).**

- **Over the socket, as a Git bundle.** A bundle carries named refs, and `git bundle create` refuses a bare commit hash, so the sender first points `refs/sotto/outgoing/<move>` at the checked commit and bundles that ref, against base commits the receiver says it already has. It removes the ref as soon as the bundle is written, since the staged file carries everything the transfer needs. It sends the bundle in chunks of at most 4 MiB of bytes each, well inside the socket's 16 MiB frame, with the move's ID and the checked commit. The receiver stages it in its data folder and checks its size, its SHA-256, `git bundle verify`, and that the bundle's one ref names exactly that commit.
- **Incoming refs are written once.** Git does not refuse a non-fast-forward fetch into a namespace outside `refs/heads` and `refs/tags`, so leaving out `--force` does not protect `refs/sotto/incoming`. The receiver records the move's ID with its commit before it imports anything. A retry of the same move, with the recorded commit, whose ref already exists and names that commit, answers as done and writes nothing, so a lost reply can be retried. Any other existing ref, or a commit that differs from the recorded one, is refused. It writes `refs/sotto/incoming/<move>/<branch>` only when that ref does not exist, with `git update-ref <ref> <commit> ""` (create only), after fetching the bundle's objects, and reads the ref back to check it. A transfer cut off leaves only the staged file, which is removed on failure and at start. A bundle over a cap the build sets, 256 MiB (Zach, October 23), is refused in plain words.
- **No SSH per move.** The desktop and links both use the socket, so no move opens an SSH session, and `check` mode never holds one. ADR-0082's decisions 1 to 4 and 6 are unchanged: committed work only, a ref of its own, nothing forced, a new worktree on the receiving side, nothing through GitHub.
- **A snapshot for a test run.** A test worker may start from a snapshot of uncommitted work (Zach, October 21). Sotto builds a commit object from a temporary index: it copies the index, runs `git add -A` against the copy, so `.gitignore` is respected, writes the tree and makes a commit with the branch's commit as its parent. No branch, no stash, and the working tree and the real index are untouched. A ref under `refs/sotto/outgoing/<move>` holds it only while it is sent, and is removed after. The receipt lists the untracked files it carried. Moves still refuse uncommitted work.

**9. What the desktop still does.** The desktop keeps Settings, the saved hosts and SSH, every link's setup and removal, Watcher, the window, dictation and its own machine's phone access, and it sends the desktop defaults. Watcher still places work by asking hosts from the desktop. Where two hosts hold a link, Watcher asks one to send a branch to the other rather than relaying it. While the laptop sleeps, Watcher's work pauses, as today, and hosts keep working with their links: remote parents delegate, children report back, and moves the owner started finish.

**10. Removing a link.** Each link has **Remove link** in Settings › Hosts, which revokes it on the machine it reaches with that machine's `revoke-client`, over SSH or an admin connection. Forget on a host removes every link to and from it on every host the desktop can reach. One it cannot reach is named, with the command to run on that machine, as a Forget notice does (ADR-0053).

**11. The tailnet policy.** A link needs the one machine to reach the other's Serve port. A tailnet with the default policy allows it. One with narrower access controls or grants needs a grant from the one machine to the other on that port. A bare machine name works in a policy file only when its `hosts` section defines it, and MagicDNS names do not, so Sotto writes the rule with the machines' tailnet addresses from `tailscale status`, for example `{"src": ["100.101.1.2"], "dst": ["100.101.3.4"], "ip": ["tcp:8443"]}`, with the port the host reports. Sotto shows the rule and the page where the tailnet's admin edits it, and never edits the policy itself.

**12. Unattended.** A Linux host starts at boot (ADR-0054). A Mac host is started by hand until a start at boot of its own is decided, so its links work only while it runs, and a machine that is not running is refused by name. A link reconnects with waits from one to thirty seconds, as Watcher's paired-host reads do, and opens a new session with its token when one expires.

**13. Privacy.** No new host is contacted: links run between the owner's own machines over the owner's tailnet, through the Serve setting each host already has. A bundle's bytes, a handover, a brief and a reply never reach a log; links log stable event names only. The README's "Privacy and cost" section says, when this ships, that hosts reach each other over the tailnet once the owner links them.

## Failure modes

| What goes wrong | What happens |
| --- | --- |
| A move stops halfway | The move record and the fence (decision 7). The source never takes sends while the target might hold the thread, and only a proved absence on the target, or its answer that it stopped and settled the thread it made, unfences it. |
| Two copies of one thread | A target start is idempotent by move ID, and the source refuses sends while fenced. |
| A watch is lost or points at a settled thread | The desktop re-points it from the confirmed move in one write, and says so in the receipt. |
| Babysitting is lost | The move waits for a press when the target has no GitHub sign-in; otherwise the target starts it and the source's ends when it settles. |
| A delegated child is stranded | Delegated threads and parents with working children are not moved. A dropped link leaves outcomes `unknown` until read exactly, and Stop names the children it could not reach. |
| A link drops during a branch transfer | The staged bundle is discarded; nothing lands in a ref. The sender's next try starts over. |
| A link is set up but the tailnet policy blocks it | The setup's test fails, says which rule is missing, and removes the half-made link. |
| The desktop is asleep | Links go on working. Watcher, Settings changes and new links wait for it. Children on This computer are refused by name. |
| A host is compromised | See Consequences. |

## Desktop relay or host links

| | The desktop relays | Host links |
| --- | --- | --- |
| Works while the laptop sleeps | No | Yes |
| Forge to the Mac | Through the laptop, twice the bytes | Straight across the tailnet |
| New trust between machines | None | One link each way, from the owner's press |
| Tailnet policy | Nothing new | Each machine reaches the other's Serve port |
| Load on the laptop | Every transfer and outcome passes through main | None for work it is not part of |
| State to keep consistent | On the desktop | On both hosts, reconciled by move and delegation records |
| Size | M, on top of the shared operations | L, on top of the relay |

The relay is the first stage, not an alternative: it proves the operations with the trust Sotto already has. Host links are the destination, because the goal is machines that keep working while the laptop is closed.

## Consequences

- **What a compromised host can reach through its links.** Through the link itself it can start threads on a linked machine in projects both have, brief them, read their replies, and push branches into `refs/sotto/incoming`. What those threads can do is their permission's, not the link's:
  - **Without link-start**, a thread is held to Ask for approval. It runs no command without the user's press, but an agent may still read files without asking, so a brief can ask it to read the project, or other files the account can read, and report back in its reply.
  - **With link-start**, a thread may start as wide as the desktop's new-thread default. At Full access, which runs any command without asking (`codex.ts`), a compromised host can have a thread on the linked machine read the account's keys, tokens and sign-ins and send them back in its reply, or change anything the account can change. So link-start trusts the other machine as far as the owner's own default reaches, and the setup's sentence must say so. Link-start can be left off for a machine the owner trusts less.
  - **Never, whatever the permission:** the link answers nothing, widens no thread, reaches no desktop, reads no thread it did not start, and cannot update or stop another host through Sotto.
  - Every such thread is visible, named as started by that machine, in the receiving machine's threads and in its parent's roster. Remove link on the desktop ends the link at once, and Stop ends its threads.
- A stolen link token works from anywhere on the owner's tailnet, like a desktop token since ADR-0053, but reaches far less.
- Hosts keep a copy of the desktop's new-thread default and worker roles, so a change made while a host is unreachable applies there only when the desktop next connects. A host never told holds linked starts to Ask for approval.
- A branch move no longer depends on SSH, so `check` mode stops holding moves for the desktop and for links alike.
- Real TLS and MagicDNS cannot run in CI. The contract is tested with two hosts behind loopback stand-ins, and only a check between forge and a Mac, recorded in `docs/verification/`, proves it.

## Proof, when built

Two headless hosts in an integration test, each behind a stand-in for its tailnet listener: setting up a link with a code, refusing a used, expired or mismatched code, the test that fails and removes a half-made link, a linked start held to Ask for approval without link-start, a start capped by the desktop defaults, a branch bundle landing in an incoming ref and a cut-off one landing nothing, a move that drops at each state and reconciles to one thread, outcomes read exactly after a drop, Stop across a link, and Remove link ending the next request. Then a live run between forge and a Mac with the laptop asleep.
