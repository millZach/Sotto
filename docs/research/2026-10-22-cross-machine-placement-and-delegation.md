# Cross-machine placement and delegation

Research, October 21, 2026. The file carries the date the request named.

**What this is.** A first draft was written by a Haiku 5.5 thread against `main` at `16c5a757a` (October 16), which was 920 commits behind. An Opus 5.5 review checked it against `origin/main` at `4004c56b9` on October 22 and found several conclusions out of date. This version is rewritten against `4004c56b9`, folds in the review's corrections and Zach's decisions of October 21, and answers his two new questions: how to tell whether his tailnet uses Tailscale SSH `check` mode, and why hosts cannot talk to each other without the laptop. Line numbers are `4004c56b9`'s. Nothing was run on forge or a Mac, and no tests or CI were started. Anything not checked is marked **unverified**.

The two draft decision records it proposes are [ADR-0104](../adr/0104-sotto-checks-whether-tailscale-will-ask-before-it-needs-ssh.md) (the Tailscale check) and [ADR-0105](../adr/0105-hosts-reach-each-other-over-host-links-the-desktop-sets-up.md) (host links). Both are Proposed.

## Summary

Zach wants threads and their sub-agents to work across every machine he has (the Windows laptop, forge on Omarchy, a Mac later, and more), to spread memory and CPU, run tests on the right system, and move threads. Other people must be able to set it up too.

- **Machine facts exist; machine choice, live load, branch moves, thread moves and remote delegation do not.** Watcher can already start workers on a paired host. A thread on another machine gets none of Sotto's tools.
- **There are no limits any more.** #1183 removed the starts limit. What is left is a warning above ten working threads, counted on this computer only. Zach wants it per machine.
- **Zach's tailnet uses `check` mode.** Sotto's own record says so (ADR-0025, September 27 amendment, #429). Every new SSH sign-in after the check period waits for a browser. ADR-0082 opens one per branch move, so moves started at night would stall.
- **The fix for both questions is the same: carry work over the host socket, not SSH.** Branches travel as Git bundles over the socket the desktop already keeps to each host (no sign-in), and later over **host links**, which let hosts reach each other's tailnet listener after the desktop sets them up once (ADR-0105).
- **Build the shared operations with the desktop as the only caller first, then add host links.** The relay proves the operations with the trust Sotto already has. Host links make them keep working while the laptop sleeps.
- **Land #1145, #1297 and the rest of #1089 before moves happen at any scale.**

Biggest risks: a move that stops halfway (two copies of one thread, or a watch on a settled thread), and two heavy test runs landing on one machine because both saw free memory. The first needs a move record with fences; the second a queue.

---

## 1. What changed since the first draft

| The draft said | On `4004c56b9` |
| --- | --- |
| Per-machine limits come nearly free from `watcherInFlightLimit`, default 4 | **Gone.** #1183 removed the limit. `settings.ts:537` lists `watcherInFlightLimit` as a key Sotto no longer reads; `watcher.ts:730`: "Nothing is held back at any number". Only a warning above ten working threads remains, counted on this computer only (`shared/workingThreads.ts`, `WORKING_THREADS_QUIET_MAX`). |
| A host-local delegation's permission ceiling is the host's own new-thread default | **Wrong.** A host's stored default never applies, because Settings saves it on the desktop only (`watcher.ts:669-679`). Without the `remote-answer` grant there, a host's workers are held to Ask for approval (#1196). |
| Remote working copies are not built (`watcher.ts:2019` refuses) | **Built for paired hosts.** The desktop forwards `list_working_copies` to the owning host (`watcher.ts:2224`), which answers for its own projects (`:3128`, `:3232`). The refusal at `:3233` is only for a project another host owns. Not tried live. |
| A delegation wake-up carries identities only | **Since October 19 it carries an answered child's reply** (ADR-0081, Decision C), privately, in a hidden wake-up. |
| The handover exists only for Watcher's provider change | **Continued threads are built** (ADR-0089, Owl `continue-on-provider`), and ADR-0089 decision 7 already plans continuing on another machine through ADR-0082. That is the base for #1178. A remote thread's history lives on its host, so its handover must be built there. |
| #1145's send refusal is at `watcher.ts:243` | Lines moved. `permission()` refuses at `watcher.ts:703-708`; `checkPermission` is `:711-717`, called for sends at `:2071` and `:2393`; the paired-master ceiling is `:718-722`. Still unfixed. |
| Windows free memory: unverified | **A good signal.** libuv (`src/win/util.c`) uses `ullAvailPhys`, which counts standby memory as available (review). |
| Muse threads cannot take Sotto's tools | `NOT_ADMITTED` (`delegation.ts:212`) now names Claude Code, Codex, Grok Build and Muse as threads that can delegate. |
| Option A is "recommended first" and B is deferred | Zach put B in scope on October 21: a parent may run on any machine and coordinate children on any other. A is still the first step. |
| (not mentioned) | The session reaper stops an idle provider session after 30 minutes (`sessionReaper.ts:35`), so moving idle threads frees little memory. #1297: worktree removal has a 30-second deadline (`threadWorktrees.ts:78`), which can leave a half-deleted worktree on Windows. #1089: a remote thread's pushes can bury a slow desktop. Worker roles (ADR-0091) are saved on the desktop and not given to a paired host's threads. |

---

## 2. What is built and what is only written down

Sizes are rough: S about a day or two, M about a week, L one to two weeks, XL longer.

| Feature | State | Where |
| --- | --- | --- |
| Host facts: OS, arch, memory, CPU count, threads running (#1031) | **Built**, desktop-only feature `host-facts`. Memory re-read when asked, at most every few seconds; no timer. | `src/main/agents/hostFacts.ts`; `src/shared/hostFacts.ts`; `host-facts` in `HOST_DESKTOP_FEATURES` (`hostProtocol.ts`) |
| `list_machines` (Watcher) | **Built.** Watcher's tool only; a delegating thread cannot see it. | `watcher.ts:2191`, `:3210` |
| Live CPU load and memory pressure (#1311) | **Not built.** | |
| Watcher starts a worker on a paired host | **Built** for hosts offering `watcher-control` and `watcher-reads`. | `docs/host-protocol.md`, "Watcher on a paired host" |
| Remote working copies for Watcher | **Built**, not tried live. | `watcher.ts:2224`, `:3128`, `:3232` |
| Default machine setting (#1032) | **Not built.** | `src/shared/settings.ts` has none |
| Per-machine limits | **Dropped** (#1183, Zach). A per-machine working count and warning are not built. | `shared/workingThreads.ts` counts this computer only (`remoteHost` threads skipped) |
| Project matched across machines by GitHub origin | Helper exists, not used for placement. | `src/main/agents/github.ts`, `sameRepository` |
| Branch move (#1033, ADR-0082) | **Decided, not built.** Spiked on forge. | No `refs/sotto` in `src`; `sshLauncher.ts:421` `baseArguments` is private |
| Handover (#1026) and continued threads (ADR-0089) | **Built**, this computer only. | `handover.ts:21` (`HANDOVER_BUDGET = 24_000`); `owlFeatures.ts:21` |
| Thread move to another machine (#1178) | **Not built.** | |
| Rebalancing (#1309) | **Not built.** | |
| Delegation on this computer (ADR-0081) | **Built**, Owl `thread-delegation`. | `delegation.ts`; `runtime.ts:237`; `src/main/index.ts:968-970` |
| `delegate` with a machine | **Not built.** | `src/shared/delegation.ts` has no machine field |
| A thread on another machine delegating (#1310) | **Not built.** | `runtime.ts:223` ("a headless host has none"), `:236`; `src/host/index.ts:109`; `delegation.ts:575-578` |
| Choose a machine by OS (#1312) | **Not built.** Facts carry `os.family`. | |
| Bring commits back (#1030) | **Not built.** | ADR-0027 |
| #1145, sends to a thread wider than the default | **Still refused.** | `watcher.ts:703-717`, `:2071`, `:2393` |
| Tailscale approval while connecting | **Built.** The launcher reads the check banner on ssh's stderr and waits up to five minutes with **Open approval page**. | `src/main/hosts/tailscaleApproval.ts`; `sshLauncher.ts:302-305`; `TAILSCALE_APPROVAL_MS` |
| Whether a device runs Tailscale SSH | **Read**, not used for a check. | `src/main/hosts/tailscale.ts:61` (`sshHostKeys` non-empty) |
| Host update without SSH (ADR-0088) | **Built.** | `host-update` |
| Long activity bodies cut for a desktop (half of #1089) | **Built** (`activity-bodies`, ADR-0025 October 18 amendment). Host backpressure for `detail` pushes is not. | `src/host/socketServer.ts:533` holds back only shell pushes |
| Mac host archive | `package-host.mjs` builds one on a Mac; no release step or workflow does. | `releasing.md:126-141` covers Linux only; `.github/workflows/owl-mac.yml` builds the desktop only |
| Mac start at boot | **Unsupported.** | `launchScript.ts:311`, `reason: 'macos'` |

Why a thread on another machine gets no Sotto tools, four ways: the delegation service is not built on a headless host (`runtime.ts:237`), and neither are Watcher's tools (`:247`); only the desktop registers thread tool servers (`src/main/index.ts:970`); admission reads only this computer's snapshot (`delegation.ts:575-578`); and the tool server binds to `127.0.0.1` with a token per thread (`threadToolServer.ts`). So it is not only delegation: a remote thread has no `sotto_visual`, no `sotto_pull_requests` and no browser tools either.

---

## 3. Question A: Tailscale SSH `check` mode

### Does Zach's tailnet use it?

Yes, at least for forge on September 27: adding forge failed until the approval was seen, because "forge's tailnet policy puts Tailscale SSH in `check` mode" (ADR-0025, September 27 amendment; `docs/verification/2026-09-27-host-tailscale-approval.md`). The guide's "Hosts over Tailscale SSH" section already explains `accept` and `check`.

### How it works, from Tailscale's own documentation

Checked against Tailscale's pages on October 21, 2026 ([Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh), [policy syntax](https://tailscale.com/kb/1337/policy-syntax), [sample policies](https://tailscale.com/kb/1192/acl-samples)) and its open-source code on `main` (not a pinned release):

- **Only machines that turned it on.** Tailscale SSH answers only on a machine whose owner ran `tailscale set --ssh`. It "takes over port 22 for SSH connections incoming from the Tailscale network", and "there is no way to configure Tailscale SSH to use a different port". An ordinary SSH server on another port is not held (inferred from the code, which intercepts port 22 and Serve ports only).
- **Only Linux and open-source macOS builds.** The server runs on Linux and on Macs using the open-source `tailscale` and `tailscaled` command line. The Mac App Store and standalone Tailscale apps cannot be Tailscale SSH targets, and nor can Windows. So a Mac reached by Remote Login is never held.
- **`check` beats `accept`.** A rule's `action` is `accept` or `check`. When a connection matches both, the `check` rule applies, so adding an `accept` rule does nothing; the `check` rule must change. `checkPeriod` defaults to 12 hours, runs from one minute to 168 hours or `always`, and changing it is a Premium and Enterprise feature.
- **The default is unclear.** Tailscale's sample default policy has a `check` rule from members to their own devices; the Tailscale SSH page says check mode is "not enabled by default". A tailnet's own policy file decides.
- **A hold waits with no limit of its own.** The server holds the connection until Tailscale's control server answers (`HoldAndDelegate`). The banner's words come from the control server, so they can change without a client update. Sotto matches "Tailscale SSH requires an additional check" (`tailscaleApproval.ts`), which is what forge printed on September 27.
- **From the client side**, `tailscale status --json` shows a peer's `sshHostKeys`, which Tailscale's own code uses "as a proxy" for Tailscale SSH being on. Nothing shows a user who is not the admin whether a rule is `check` or `accept`; only the admin console's access controls page does. `tailscale whois` names a node and user, not the policy.

### A check Zach can run today

In PowerShell on the laptop:

1. **Does forge use Tailscale SSH?** `tailscale status --json | ConvertFrom-Json | ForEach-Object { $_.Peer.PSObject.Properties.Value } | Where-Object HostName -eq 'forge' | Select-Object HostName, @{n='TailscaleSSH'; e={ [bool]$_.sshHostKeys }}`. `True` means forge answers SSH with Tailscale SSH. On forge itself, `tailscale debug prefs` should show `"RunSSH": true` (**unverified** on forge).
2. **Does the policy hold it?** Open the Tailscale admin console's access controls page and look in the `"ssh"` section for a rule with `"action": "check"` whose `dst` covers forge (for example `autogroup:self`).
3. **Does it hold now?** `ssh -o BatchMode=yes -o ConnectTimeout=15 forge true; $LASTEXITCODE`. A banner naming `login.tailscale.com`, or a wait that does not end, means Tailscale is holding it. `0` straight away means it is not holding now, which may only mean an approval in the last 12 hours, so step 2 is the sure answer.

To stop the asking for forge, either change that rule's `action` to `accept` for forge, or run `tailscale set --ssh=false` on forge and use its own OpenSSH server (Omarchy may need `sshd` enabled first, **unverified**). Once branches move over the socket, the remaining asks are rare presses (Stop host, Start at boot, Phones…, Forget), so leaving `check` on is also reasonable.

### What Sotto should do

ADR-0104 has the design. In short:

1. **Stop needing SSH for moves.** Branches go over the host socket as Git bundles (ADR-0105 decision 8), on the tailnet connection or the SSH connection's existing forward, so no move ever signs in. This removes the case that matters most: a move nobody is watching.
2. **Look before asking, without a probe sign-in**, since a probe would itself ask for an approval. Sotto reads this computer's `tailscale status --json` when a machine is added and when a saved host connects: a device that publishes SSH host keys runs Tailscale SSH and may be held. When Sotto sees a hold on a host, it records when, and keeps the record until Tailscale SSH is turned off there, since a sign-in that later goes straight in may only mean an approval that lasts up to 168 hours. Then it can say "Tailscale may ask you to approve this in your browser" before a press rather than after.
3. **Say what is wrong in plain words** and what to do, with the two fixes that need no browser: change the `check` rule covering Sotto's machines to `accept` (an extra `accept` rule does nothing), which the tailnet's admin does, or use the machine's own SSH server, with Tailscale SSH off or on another port, which Tailscale SSH does not hold.
4. **Fall back to the socket.** Anything that can go over the socket does. What still needs SSH (Add host, pairing, grants, Stop host, Start at boot, Phones…, Forget) keeps today's approval wait.

---

## 4. Question B: hosts talking to each other

### Why they cannot today

Nothing technical stops it. Every connection starts at the desktop because Sotto began with one laptop and one forge: the desktop holds the saved hosts, their SSH targets and identity files, each host's pairing token, the Settings every start is held to, and Watcher. A host knows its own threads and its paired clients and nothing about any other host. ADR-0082 moves a branch between the desktop and one host, so forge to a Mac would go through the laptop.

### The design

ADR-0105 proposes **host links**. The desktop sets each pair up once, on the owner's press, while it is connected to both:

1. Over the Mac's SSH connection, the desktop gets a single-use **link code** bound to forge's host ID and tailnet node.
2. It hands the code to forge over forge's SSH connection. The code never travels on a listener and is never saved.
3. Forge redeems it at the Mac's tailnet address. The Mac checks the code, and asks its own Tailscale who the caller is, as evidence that can only refuse.
4. The Mac records forge as a **linked machine** itself. Forge keeps the Mac's address and token.
5. The same is done the other way, and both are tested at once. A test that fails says which tailnet rule is missing and removes the half-made link.

After that, forge and the Mac talk over each other's tailnet listener (HTTPS on Tailscale's certificate, the host socket, no SSH).

**Trust.** A link is a pairing, so it is admission, not authority (ADR-0004). A linked machine has its own closed list: send a branch (it can only send, never fetch), start and drive delegated threads for its own parents, offer a move, read host facts. Its starts are held to Ask for approval unless the owner gave that link **link-start** at setup, and are capped by the desktop's new-thread default, which the desktop now sends each host as **desktop defaults**.

**What a compromised host can reach.** Through the link it can start threads on a linked machine in projects both have, brief them, read their replies, and push branches into `refs/sotto/incoming`. What those threads can do is their permission's. At Ask for approval they run no command without the user's press, but an agent may still read files without asking, so a brief could ask it to read files and report back. With link-start, a thread may start as wide as the desktop's new-thread default. At Full access, a compromised host could have it read the account's keys and sign-ins on the linked machine and send them back in its reply. So link-start trusts the other machine as far as the owner's default reaches; the setup must say so, and it can be left off for a machine trusted less. Whatever the permission, the link answers nothing, widens no thread, reaches no desktop and reads no thread it did not start. Every thread it starts is visible and named as started by that machine. **Remove link** ends it.

**Tailnet policy.** The default policy lets every machine reach every other. With narrower access controls or grants, each linked pair needs a rule letting one reach the other's Serve port. Sotto writes it with the machines' tailnet addresses, since a bare name works only when the policy's `hosts` section defines it, shows it, and never edits the policy.

**Unattended.** Linux hosts start at boot (ADR-0054). A Mac host runs only after someone starts it, until a start at boot for macOS is decided. Links reconnect with backoff and renew their sessions with the token.

**How a remote parent's outcomes travel.** The child's machine keeps its record and pushes outcome changes over the link. The parent's machine turns them into the parent's hidden wake-up, with an answered child's reply, as today. After a drop, every open delegation is read exactly; what cannot be proved stays `unknown`, and nothing is resent.

**How a move travels.** A move is ADR-0089's "continue", on another machine: a new thread. Both machines keep a move record with states. The source is fenced first, the branch goes as a bundle, the handover and facts block are built on the source machine (where the history is), the target starts the new thread, and the source is settled once the new thread's first turn ends. Only a proved absence on the target, or its answer that it stopped and settled the thread it made, unfences the source.

**What the desktop still does.** Settings, saved hosts and SSH, every link's setup and removal, Watcher (which lives on the desktop and pauses while it sleeps), the window, dictation, its own machine's phones, sending desktop defaults, and re-pointing watches after a move.

**Failure modes** (ADR-0105 has the table): a half-moved thread (fence plus move record), duplicate threads (idempotent by move ID), lost watch state (the desktop re-points it from the confirmed move), PR babysitting (moves with the thread, or the move waits for a press when the target has no GitHub sign-in), delegated children (delegated threads and parents with working children are not moved; Stop across a dropped link names what it could not reach), and a transfer cut off (the staged bundle is discarded).

### Desktop relays everything, or host links

| | The desktop relays | Host links |
| --- | --- | --- |
| Works while the laptop sleeps | No | Yes |
| Forge to the Mac | Through the laptop | Across the tailnet |
| New trust between machines | None | One link each way |
| Tailnet policy | Nothing new | Each reaches the other's Serve port |
| Load on the laptop | Every transfer passes through main (#1089) | None for work it is not part of |
| Size | M, on the shared operations | L, on the relay |

**Recommendation.** Define the operations once on the host socket (send a branch, start and drive a child elsewhere, move a thread), and build them with the desktop as the only caller first. That is the relay, and it needs no new trust. Then add host links as a second caller of the same operations, once a third machine is connected and verified (#1314). Do not build a separate relay design that links would replace.

---

## 5. A thread on another machine delegating (#1310, #1316)

**Step one: children on the parent's own machine (A).** The host builds the delegation service and the tool server for its own threads, on its own loopback with its own tokens (`runtime.ts:237` stops skipping them). What it needs from the desktop:

- **The ceiling and the roles.** The desktop's new-thread default and worker roles, sent to each host as desktop defaults when the desktop connects and when Settings change. A host never told holds delegated starts to Ask for approval. Without the `remote-answer` grant there, the existing hold to Ask for approval stays (#1196).
- **The other tools too.** The same change can register `sotto_visual` and `sotto_pull_requests` on the host. Each is its own decision; the browser stays this computer's.
- **A read for the roster.** The desktop already joins every host's threads. The parent's Tools › Agents shows its children with their machine.
- **The Owl answer.** The host's own track decides (`src/host/index.ts:102`). Every Owl release publishes the Linux host archive, so forge stays on the desktop's track.

**Step two: children on another machine (#1316).** In scope since October 21. Through the desktop's existing connections first (relay): the host asks the desktop, which starts the child under the same rules and reports back. Then over host links (ADR-0105), so it keeps working while the laptop sleeps. A child on This computer is always reached through the desktop's connection, and only while the desktop is connected; otherwise `delegate` refuses by name.

ADR-0081 decision 10 is amended (ADR-0105 decision 6). Limits: none (#1183); the four-prompt budget is enforced on the parent's machine; the warning above ten working threads is counted on each machine.

---

## 6. Live load (#1311)

| Signal | Windows | Linux | macOS |
| --- | --- | --- | --- |
| CPU busy | `os.cpus()` deltas between two samples | Same | Same |
| Load average | Always `[0,0,0]` (Node docs) | `os.loadavg()` | `os.loadavg()` |
| Available memory | `os.freemem()` is `ullAvailPhys`, standby counted as available. Good. | `MemAvailable` from `/proc/meminfo`. Good. | `free_count` pages only, so it understates; `process.availableMemory()` gives the same. Report it as unknown, or read `sysctl kern.memorystatus_level` (**unverified**, needs the Mac). |
| Pressure | Free over total only | `/proc/pressure/memory` where present | `kern.memorystatus_level` (**unverified**) |

- Read on demand, like host facts. A busy reading takes two samples a few seconds apart, and the host keeps the last. No timer, no PowerShell per read.
- Numbers only, with an observation time; null when unknown. A reading older than a minute is unknown for placement, not idle.
- Add **work placed but not started**, so two starts seconds apart do not both see the same free memory.
- Starting thresholds, to tune on the laptop and forge: short on memory under 2 GiB or 10% of total on two readings; busy above 85% CPU over the window.

---

## 7. Moving threads (#1178) and suggestions (#1309)

**A move is "continue on another machine"** (ADR-0089 decision 7), not a moved session: a new thread with its own ID, seeded with the fixed handover plus a facts block Sotto writes (branch, commit, pull requests, watch). Zach settled that on October 21, so #1178's "handoff document the agent writes" is replaced, with his agreement.

**Clean points.** All of these hold, and are checked again at the fence: no turn running, no question or permission card, no background work, no unresolved send in the outbox (ADR-0058), no uncommitted work, not a delegating thread with children working, not any delegated thread (its news could not reach its parent), not Watcher.

**The original.** Settled once the new thread's first turn ends; its worktree is kept, and no automatic cleanup runs while #1297 is open.

**Narrower on arrival.** A move that would start narrower, or without the GitHub sign-in its babysitting needs, says so and waits for a press. Adding a machine offers "let this computer answer there", so most moves keep their permission.

**State that travels.** The branch (bundle), the handover (built where the history is), the facts block, babysitting (started on the target), the watch (re-pointed by the desktop in one write). Delegation links stay with the original, because delegated threads and parents with working children do not move.

**Rebalancing is suggest-only** (Zach). Watcher's room shows that a machine is short on memory or busy and that another has room, with one press to move a named thread through the same flow. Nothing moves on its own. The draft's P1 (move idle threads automatically) is dropped: the session reaper already stops idle sessions after 30 minutes, so it would free little. #1309 should be reworded as "Suggest moving a thread to a machine with room" and wait on #1311 and #1089 as well.

**Size.** #1178 is L, not XL, built on ADR-0089, the bundle transport and the move record.

---

## 8. Tests on the right system (#1312)

- **Naming a system.** `os: windows | macos | linux` beside the machine on `start_thread` and `delegate`, matched against `facts.os.family`. This belongs in #1032 with the machine choice. An explicit system never falls back to another. With none connected: "No Mac is connected. Connect a Mac, or run this on This computer. Nothing was started."
- **Uncommitted work** (Zach, October 21). The test worker starts from a **snapshot**: a commit object built from a temporary index (`.gitignore` respected), with the branch's commit as parent. No branch, no stash, working tree and index untouched. Moves still refuse uncommitted work. This also answers the review's point that "commit first" is unsafe on a shared checkout, where it would commit onto whatever the user has checked out. ADR-0105 decision 8 has the steps.
- **One full test suite per machine at a time** (Zach). A **test run** is a delegation Sotto knows is one, because the call says so, not because Sotto spots `npm test` in a process list. The machine runs one; the next waits in a queue, and its outcome says "Waiting for forge's test run to finish. 1 ahead." The queue is the machine's own, so it holds for every parent and for Watcher.
- **Worktrees.** A fresh worktree per run needs `npm ci` (about 1.4 GB and minutes) and fills disks (ADR-0041's 107 GB). Reuse one test worktree per project per machine, moved to each snapshot, and keep its `node_modules`. Sotto records the lockfile's hash that `node_modules` was installed from, and when a snapshot's `package-lock.json` differs, runs `npm ci` there and waits for it to finish before the tests start, so a run never uses the previous snapshot's packages.
- **Results.** The reply is the contract: pass or fail, counts, and the failing lines, inside the 32 KiB reply cut. The full log stays in the child's history.

---

## 9. A Mac (#1314)

- **The archive.** Add `npm run package:host:owl` to `.github/workflows/owl-mac.yml`, so every Owl carries `Sotto-host-<version>-darwin-arm64.tar.gz` and its sidecar (Zach, October 21). Today only the Linux archive is a release step (`releasing.md:126-141`). Node 24 on the runner (`package-host.mjs:36`).
- **Started by hand** for now (Zach). Start at boot is unsupported on macOS (`launchScript.ts:311`); a `launchd` unit is a later decision.
- **The Mac needs:** Remote Login (or Tailscale SSH), Tailscale, Git (Xcode Command Line Tools), the project cloned, provider sign-ins, `gh` signed in for babysitting, Xcode for iOS work. Tailscale SSH's server runs on a Mac only with the open-source `tailscale` command line, not the App Store or standalone app, so a Mac is reached by Remote Login and `check` mode never holds it.
- **Two Sottos on one Mac.** A Mac that runs the desktop app already has a local host; a headless host beside it would be a second. Pair one or the other.
- **Facts.** Do not place work by memory on a Mac until its reading is fixed (section 6).
- **Proof.** A verification note once a Mac stays connected.

---

## 10. Build order

| # | Work | Issues | Size | Before building |
| --- | --- | --- | --- | --- |
| 0 | This note and the two Proposed ADRs | | S | Zach's acceptance of the ADRs |
| 1 | Sends allowed, starts still refused | #1145 | S | Nothing: Zach chose the words (keep the start refusal) |
| 2 | Worktree cleanup never leaves a half-deleted worktree | #1297 | S–M | Nothing; no UI |
| 3 | Host backpressure for `detail` pushes, and reconnect when far behind (what #1089 still lacks) | #1089 | M | Nothing; no UI |
| 4 | The Tailscale look-before-asking and its plain words | ADR-0104 | S–M | Clarifying questions on the words; prototype of Add host's step and the host row |
| 5 | Default machine; machine and `os` on `start_thread` and `delegate`; `list_machines` for a delegating thread; projects matched by GitHub origin; working threads per machine with the warning above ten on each | #1032, #1313, the `os` part of #1312 | M | Clarifying questions; prototype update (the chips lose the limit line and gain the per-machine count) |
| 6 | Live load, with work placed but not started | #1311 | S–M | Nothing new; shown on step 5's chips |
| 7 | Branches over the host socket as bundles, the desktop as caller | #1033 core, ADR-0082 amended | L | Nothing; receipts only |
| 8 | Start from a branch, and the snapshot for test runs | #1033 rest | M | Clarifying question on the words for "from my branch" and "with my uncommitted changes" |
| 9 | Test routing: test runs, one per machine with a queue, a reused test worktree, the reply contract | #1312 | M | Clarifying questions; prototype of the queue's line on the delegation card |
| 10 | A Mac host archive with every Owl, then a verification note | #1314 | M | Nothing; needs a Mac that stays on |
| 11 | A thread on another machine delegates to its own machine; desktop defaults sent to hosts | #1310 | M–L | Prototype of a remote parent's roster |
| 12 | Children on another machine through the desktop | #1316 | M | Clarifying question on the refusal when the laptop is away |
| 13 | Move a thread: continue on another machine, with the move record, through the desktop | #1178 | L | **Prototype and clarifying questions first** (where Move lives, the move's states, Keep it here) |
| 14 | Host links: setup, linked delegation, host-to-host moves | ADR-0105, #1316 | L | **Prototype and clarifying questions first** (the setup dialog, link-start, the link's row) |
| 15 | Suggest moving a thread to a machine with room | #1309 | S–M | **Prototype and clarifying questions first** |
| 16 | Bring commits back to the parent's branch | #1030 | S–M | Prototype exists (variant B); any time after step 8 |

Steps 1 to 3 can run in parallel, and so can 5 and 6. Step 7 needs nothing from 5. Step 14 waits for step 10, since links matter once there is a third machine.

---

## 11. Decisions

### Settled by Zach on October 21

1. No per-machine limits. Show working threads per machine and warn above ten on each.
2. A parent may run on any machine and coordinate children on any other. Children on the parent's own machine come first.
3. Uncommitted work for test runs is snapshotted into a commit object from a temporary index. Moves still refuse uncommitted work.
4. A move hands over with the fixed handover plus a facts block Sotto writes.
5. The original is settled, its worktree kept until the new thread's first turn ends, and no automatic cleanup while #1297 is open.
6. Rebalancing only suggests.
7. Adding a machine offers "let this computer answer there". A move that would come back narrower says so and waits for a press.
8. One full test suite per machine at a time; the next waits in a queue and says so.
9. A Mac host archive ships with every Owl, started by hand for now.
10. Sends to wider-permission threads are allowed; starts are still refused (#1145).
11. Stable stays untouched; all of this is Owl.

### Answered by Zach on October 22, on the question card

12. **Host links (ADR-0105):** relay first, then links. The operations are built with the desktop as the only caller, and host links are added once a Mac is connected. This also settles #1316: children on another machine go through the desktop first.
13. **Link-start at setup:** offered, and on by default, with its sentence on the press, as for a desktop's own grant on September 29.
14. **Zach's own tailnet:** leave `check` on for forge for now, and decide again once branches move over the socket.
15. **Test runs:** the call says it is a test run; Sotto does not spot test commands.

### Still open, with recommendations

1. **Desktop defaults on hosts.** The desktop sends each host its new-thread default and worker roles, which hosts keep. *Recommended: yes*; they are settings, not keys, and a host without them holds starts to Ask for approval.
2. **The bundle cap** for one branch transfer. *Recommended: 256 MiB*, refused in plain words above it.
3. **Sotto's other tools on remote threads** (`sotto_visual`, `sotto_pull_requests`) with step 11. *Recommended: yes, each its own small change*; the browser stays this computer's.
4. **A Mac that also runs Sotto's desktop app** already has a local host. *Recommended: pair the Mac as a headless host only if it is a machine that stays on for tests.*
5. **The words** for each step's refusals and receipts, asked when each step is built.

---

## 12. Issue text corrected on October 22

The review's list of stale issue text was fixed on GitHub, and the changes are recorded on #1023:

- #1309 is now "Suggest moving a thread to a machine with room", waiting on #1311 and #1089 too.
- #1310 is part A, children on the parent's own machine. #1316 is new: part B, children on other machines.
- #1311 has the platform notes and work placed but not started.
- #1312 is now "Send test runs to a machine of the right system, one at a time". Its `os` choice moved to #1032.
- #1313 is folded into #1032 and #1033 and left open for Zach to close.
- #1314 has the Mac prerequisites and the Owl workflow step.
- The stale text in #1032, #1033, #1145, #1178 and #1023 is corrected.

## Not verified in this pass

- Anything live on forge or a Mac.
- A bundle of a named outgoing ref, and its size on Sotto's repository. (`git bundle create` refuses a bare commit hash; the review reproduced that.)
- Tailscale's local `whois` from a headless host's account without operator rights.
- macOS memory pressure from `sysctl`.
- Apple's OpenSSH with the launcher's options.
- `tailscale debug prefs` on forge, and whether Omarchy runs `sshd`.
- The exact banner Tailscale's control server sends today, and whether `ConnectTimeout` covers a held sign-in.
