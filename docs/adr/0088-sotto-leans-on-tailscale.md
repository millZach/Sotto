# Sotto leans on Tailscale

## Status

Accepted October 16, 2026 by the owner. Zach decided on October 16 that Sotto leans on Tailscale, and that a host update works over the host's tailnet connection without SSH, straight to stable rather than as an Owl feature ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). Amends [ADR-0040](0040-an-older-host-is-updated-from-the-threads-page.md), [ADR-0053](0053-a-desktop-reaches-a-host-over-its-tailnet-first.md) and [ADR-0054](0054-a-host-can-start-at-boot-on-linux.md), and builds on [ADR-0025](0025-headless-host-and-client-identity.md), [ADR-0033](0033-the-desktop-lets-paired-phones-reach-its-threads.md), [ADR-0050](0050-a-hosts-phone-access-is-turned-on-from-the-desktop.md) and [ADR-0004](0004-authority-in-policy-records.md).

The feature is built in two pull requests. The first, `feat/host-updates-itself`, is the host half: a host updates itself when a paired desktop asks over its socket. The second, written after it, makes the desktop use that route, and follows this record. Where the decision did not reach, the picks below are the agent's, made while building the host half, and each says so.

## Context

Phones reach a computer only over the owner's tailnet (ADR-0033, ADR-0050). Since ADR-0053 a desktop reaches a host there first too, so a relaunch, a reconnect and a dropped connection need no SSH. A tailnet whose Tailscale SSH policy is in `check` mode holds every SSH sign-in after the check period for an approval in a browser.

Every press that changes something on a host still opens an admin connection, which is an SSH sign-in. Update is the one pressed most, and the one most likely to be pressed with nobody watching the browser: from the press to the restart it runs three launch script operations, and with Update all on Owl (ADR-0077) the hosts update while this computer downloads Sotto. In `check` mode each Update waits for an approval first. Everything Update does on the host is the launch script's, and the host already runs Node and can run that script against itself.

The options considered:

1. **Keep SSH for every update.** Rejected: it keeps the approval on the press that most often has nobody there to give it.
2. **A relay server, or another private network.** Rejected: Sotto would run a server, or ask the owner to run one, and contact a host the README does not name, for something Tailscale already does for the owner's machines.
3. **The host updates itself when a paired desktop asks over its socket.** Chosen.
4. **Trust Tailscale's identity headers to admit the request.** Rejected, as in ADR-0053: they name a tailnet user, not a paired client, and only a policy record grants authority (ADR-0004).

## Decision

**1. Sotto leans on Tailscale.**

- Tailscale is required for phones, as it has been since ADR-0033.
- Tailscale is recommended for hosts. Add host turns on a host's tailnet connections when Tailscale runs there (ADR-0053). A host without it works, over SSH, with SSH's approvals.
- Plain SSH stays the way into a host that always works. Add host, pairing, the `remote-answer` grant, the desktop record and every launch script operation still go over it, and it carries the socket whenever the tailnet does not answer.
- No relay server, and no other private network. Sotto runs no server of its own, and Tailscale Funnel is never used.

Why: Tailscale already gives the owner's machines a private, authenticated path with real certificates and names, and Sotto only asks it for a Serve setting it owns. A relay would be a new host, a new party to trust and a service to keep running. SSH needs nothing but an account, and it is how a host is set up and trusted in the first place, so it stays as the way in when everything else is missing.

**2. A host update works over the host's tailnet connection without SSH.**

- The host runs its own update when a paired desktop asks over its socket. Only Update moves. **Stop host**, **Start at boot**, **Phones…** and Forget's revoke stay on SSH, through an admin connection when the host is on its tailnet connection (ADR-0053).
- When the tailnet does not answer, or the host does not offer the route, the update runs over SSH as it does today.
- It goes straight to stable.

**3. What the host does (the host half).**

- **The route.** A new optional host protocol feature, offered only by a host that can run it, `host-update`, with a request of that name on the closed request list (ADR-0025's September 22 amendment), not an agent command. `docs/host-protocol.md` has the wire shape: the request's five actions (`fetch`, `install`, `restart`, `cancel`, `outcome`), their answers, and a `host-update-step` push.
- **One implementation.** The host runs the launch script it ships for SSH (`LAUNCH_SCRIPT_SOURCE`) against itself, as a child process, with the source on stdin as over SSH. The download, the checksum, the unpack, the Node range, the version conflict, the update lock, the restart, the rollback and the prune are the script's, unchanged.
- **The host builds everything the script reads.** The installation folder comes from where the host's own entry sits: `<installation folder>/versions/<version>/host/index.js`, whose version must be the one the host runs, or `<installation folder>/host/index.js`. Any other layout offers nothing (the agent's pick: the host updates only a folder it can be sure the launch script starts). The data folder and port are the host's own command line's, the same ones the launch script and the boot unit's script pin. The Node is the host's own, and the key file is whatever `SOTTO_HOST_KEY_FILE` its environment names, as for any process it starts. The host ID is its own. The timings are the launch timings the desktop sends, now in `src/shared/hostLaunchTimings.ts` so the two cannot drift. The releases page is the fixed one Sotto publishes; only a test may stand in another, through the host's start options.
- **The client names only a version.** For `install` it also sends back the archive name and checksum the host's own download answered, and the name must be the one for the host's own system. The client never sends a URL, a path, a Node or a setting.
- **Newer only.** Every step refuses a version that is not a release number newer than the one the host runs, by the rule the desktop uses to decide a host needs an update (`compareHostToTarget`, which both now share). `versions/` keeps the version before the running one, so without this a client could move the host back. A version that is not newer is `update-invalid` (the agent's pick, so the desktop needs no new sentence).
- **The restart outlives the host it stops.** It runs detached in its own session. For a host its start at boot unit runs, it runs in a transient user unit of its own instead (ADR-0054's October 16 amendment).
- **A handshake through the data folder.** The restart reports in `host-update-status.json`. It writes `restarting` once its checks have passed, at the point it says `restart` today, or the reason it stopped before touching anything, and later its final result. The host waits up to about ten seconds for either, then answers. Each restart is one attempt with a claim file of its own, and whoever makes it first decides the attempt: when the host stops waiting it claims the attempt itself with `restart-not-sent`, so a restart that passes its checks after that stops without touching anything, and no later attempt can revive it. Once its `update-restarting` answer is on the way to the desktop, the host says so in a file beside the status file, and the restart waits up to five seconds for that before it stops the host, so the answer is not cut off with the connection (the agent's pick). `outcome` reads the status file, so a desktop that has connected again to the new host, or to the old one started again, learns how the restart ended. A `restarting` whose process has gone, or that is older than any restart takes, reads as finished with `update-lost`, the reason the desktop already words as a restart it cannot tell the end of, beside the version the host says it runs (the agent's pick of an existing reason). The host clears the status file when a new restart begins and reads at most 4 KiB of it. The files hold versions, attempt tokens, a process ID and the script's reason codes, nothing else.
- **One update at a time.** The host runs one update action at a time, whichever listener asked. The installation folder's update lock decides between processes, through the launch script's one implementation of it. Every step holds it, the download too, over SSH as well as on the host itself, so an update over SSH and one over the socket refuse each other with `update-busy`. Before this a download over SSH took no lock, so that a cancelled one still finishing never held up the next; one now gives the lock up once it notices it is orphaned, and a killed one leaves a lock whose process has gone, which the next update takes over (the agent's pick).
- **A download ends with its desktop.** `cancel` from the desktop that asked, or that desktop's socket closing, ends a download, as Cancel update ends one over SSH. An install finishes once started, and so does a restart.
- **The same reasons.** Failures are the launch script's own reason codes, so the desktop turns them into the sentences it already has (`HostUpdates.describe()`). `update-invalid` also covers a version that is not newer, and `restart-not-sent` a restart that did not pass its checks in time.

**4. How the desktop chooses (the desktop half, in the next pull request).**

- When Update is pressed for a host on its tailnet connection whose hello lists `host-update`, every step goes over the socket, and no `ssh` is spawned. The panel, its steps, Cancel update, the busy-host question and the wait for the host's client update line (ADR-0040's October 16 amendment) are unchanged: this computer still decides when to ask for each step. A host on its SSH connection keeps running the launch script over that connection as today, since that press signs in nothing new (the agent's pick).
- Otherwise the update opens an admin connection as today: a host whose hello does not list the feature (an older host, one Sotto did not start, one whose desktop record or grant is missing), and a tailnet connection that drops or does not answer before the install has begun.
- When the host's own download cannot reach GitHub (`download-unreachable` or `download-failed`), this computer downloads the archive and copies it over SSH, as today, through an admin connection: `update-receive` stays SSH-only. The steps after it may go over the socket again.
- After `update-restarting`, the socket drops with the host. The desktop reconnects as after any restart (ADR-0053's first-minute rule), then reads hello's version and asks `outcome`, and ends the update as done or failed from those, with the same sentences.
- A drop before the restart answers ends that try as a lost connection does today, and Try again starts over; an identical version already installed is reused.
- The desktop half amends `README.md` and `docs/guide.md`, since Update no longer asks for Tailscale's approval on a host's tailnet connection.

**5. Authority and security.** The tailnet adds no grant, as ADR-0053 said, but a desktop's pairing token can now do one more thing from the tailnet.

- **What is newer than ADR-0053's Consequences.** A stolen desktop pairing token, used on the owner's tailnet, can now make the host install and restart into a newer published Sotto release. It cannot choose the code, a URL, a file name, a path or a downgrade. The trust is still "trust the release", as installing one by hand is (ADR-0040).
- **The limits.** Only a desktop: the client must be in `desktop-clients.json`, which only the launch script writes, over SSH. Its `remote-answer` policy must let it answer (ADR-0004), read again at each request, so `--deny-answers` on the host takes the route away at once. Only a host Sotto started (`startedBy` is `launch-script` or `boot`), from a release's own layout. One update at a time. No administrative route and no administrative token ever reaches the tailnet: the route is a socket request on the closed list, on a listener that has none.
- **Tailscale's approval no longer gates Update.** In `check` mode, the approval was a second confirmation of a press the owner had made. The owner's Update press is the consent now, as it is for every other socket command.

**6. Privacy.** No new host is contacted. The host downloads from the releases page it already does (ADR-0040), only when the owner presses Update. The request carries a version, an archive name and a checksum. Logs carry stable event names only.

## Consequences

- A host on its tailnet connection updates with no `ssh` and no Tailscale approval. Stop host, Start at boot, Phones… and Forget still ask for one there, through an admin connection.
- A stolen desktop token reaches one more thing (decision 5). It still ends only when the token is revoked, over SSH or with the host's own `--revoke-client`.
- The host bundle carries the launch script, about 70 KB more, with no new external module.
- The launch script reads its configuration as its last argument, so it runs the same from stdin, with `-e` or as a file, and `update-restart` takes an optional `resultFile`, which only a host updating itself sends.
- The transient unit's restart is tested with stand-in processes; only a check on a real Linux host with start at boot, recorded in `docs/verification/`, proves it. The desktop half's pull request carries that check.
- An older host does not list `host-update` and keeps updating over SSH. A host updated over SSH to a build with the route offers it from then on.
