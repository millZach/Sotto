# Plan: reach a remote host over the tailnet first, and let it start at boot

Status: decided October 5, 2026. The decisions are [ADR-0053](../adr/0053-a-desktop-reaches-a-host-over-its-tailnet-first.md) and [ADR-0054](../adr/0054-a-host-can-start-at-boot-on-linux.md), both Accepted; section 7 records the owner's delegated picks, and the prototype is `docs/prototypes/host-tailnet-prototype.html` (variant C with A's controls). This plan is the work that follows from them, in the order of section 5. Line references (`file:line`) are to origin/main at 1594b4a5, where the design was written, plus #735 (the new-thread fix), which merged first; they drift as the work lands.

## 0. Names (CONTEXT.md, coined in PR 1)

- **Tailnet connection.** The desktop's connection to a host through the host's tailnet address, authenticated by its pairing. The existing path becomes the **SSH connection**.
  - Avoid "route": ADR-0025 and guide:202 already use it for the SSH address.
  - Avoid "direct" and "tunnel".
- **Tailnet address.** `https://<MagicDNS name>:<Serve port>`, as the host reports it. It is learned, never typed.
- **Tailnet listener.** The host's second loopback listener, which Tailscale Serve carries. It was the "phone listener" and now carries phones and desktops.
- **Start at boot.** A host's systemd user unit, installed by Sotto, which starts the host when its machine starts.
  - Avoid "service" (taken by **Host service**, CONTEXT:209), "daemon" and "supervisor".
- **Admin session.** An SSH connection opened only for one administrative press and closed after it.

## 1. Model

### What a saved host stores

`remoteHostSchema` stays as it is. It is `.strict()`, and an older Sotto would reset `remote-hosts.json` to `[]` if it met a new key. The new state goes in a separate store, `<userData>/remote-host-tailnet.json`, keyed by saved id:

```ts
{ id, prefer: 'tailnet' | 'ssh', address?: string, addressSeen?: number }
```

- `prefer` defaults to `'tailnet'`.
- It changes through a new `HostsCommand` `set-connection`. That is IPC, not a setting, so the allow-list is not involved.
- Forget deletes the entry.

### How the address is found

The host writes its own state into `host-listener.json` (`tailnetAddress`, `startedBy`).

The launch result and the authenticated `hello` both report:

- `tailnetAddress`: the real Serve port, so #729's 10000 fallback is picked up without hard-coding 8443;
- `startedBy`.

The desktop keeps the latest address it was given. It accepts only `https:` on a `*.ts.net` name, and the client-side `endpoint()` enforces that for any non-loopback URL. Matching the name against this computer's `tailscale status` peers counts as evidence only. Identity is still the TLS certificate, the pairing token, and `session.hostId === saved hostId`.

### Order and fallback

This is `DesktopHosts.open()`, rebuilt as a small pure planner (`hostConnectionPlan.ts`) so it can be unit-tested.

1. **Tailnet first.** If `prefer = tailnet`, an address is known and a credential exists, run `SocketHostService` against the address: health (5 s), then session, then socket. No ssh is spawned.
2. **Failure classes on the tailnet** (new codes, mapped to the retry rules):
   - `tailnet-unreachable`: DNS, connect, TLS, timeout, or 502/503 from Serve. Go to SSH.
   - `tailnet-wrong-host`: Go to SSH.
   - `pairing-required` (401): Go to SSH, which re-pairs over the forward exactly as today. The desktop never pairs at a tailnet `/v1/pair`; `SocketHostService.pair()` refuses any non-loopback URL.
   - `version_mismatch`: stays final, as today.
3. **SSH.** Today's launch, pairing and desktop-answers. Then, if the launch reported an address and `prefer = tailnet`:
   - Check the tailnet (health and session). If it answers, open the socket there and close the forward. The admin token goes with it.
   - Otherwise open the socket over the forward. The row then says SSH.
4. **Back to the tailnet.** While connected over SSH with tailnet preferred, check the tailnet every 5 minutes and move across when it answers.
5. **Drops and moves.** A drop or a move between connections uses `router.setReconnecting` followed by `router.replace`. This generalises the update-restart `held` path, so threads and selection stay on the page. `router.remove` is called only on Forget or switch-off.
6. **Retry cadence.** Backoff stays 3/4/8/16 s.
   - If the host starts at boot and the last connection was a tailnet connection, the first 60 s of retries are tailnet-only: the host restarts by itself, and SSH would ask for approval for nothing.
   - After that, each attempt is the tailnet and then SSH.
   - A Tailscale approval during an automatic SSH retry shows as it does today.

### Host row (meta line)

| State | Meta line |
|---|---|
| Tailnet, connected | `Tailnet · Connected · 2 providers · Phones on` |
| SSH because the tailnet did not answer | `SSH forge · Connected · Tailnet did not answer` (description: "Sotto tries it again every 5 minutes.") |
| SSH by choice | `SSH forge · Connected` (unchanged) |
| Connecting | `Connecting over your tailnet…` then `Connecting over SSH…` |
| Reconnecting, off, error | Unchanged |

`HostStatus` gains `via: 'tailnet' | 'ssh'`, `tailnetNote?`, `startedBy?` and `bootStart?`.

### What opens an admin session

Each of these opens an SSH admin session:

- the **Phones…** dialog, held open while the dialog is open;
- **Stop host**;
- Forget's stop of an owned host;
- **Update host** (from pill press to restart);
- **Start at boot** install and remove;
- **Edit connection** save, which is a test connect;
- re-pairing after a 401.

An admin session is today's `SshHostConnection` with the socket no longer riding on it. It starts with a connect, so a Tailscale check-mode approval shows inside the surface that asked: "Waiting for your approval in Tailscale" and **Open approval page**. This also removes today's "approval only while it connects" dead end (sshFailure.ts:143). The session closes 60 s after its last use. The admin token stays in memory for that one SSH connection, which is ADR-0050:25 as written.

Not SSH:

- Provider sign-in and client updates go over the socket.
- Forget's revoke uses the client's own `/v1/revoke` over the socket.
- Host setup and provider jobs are agent threads that run `ssh` themselves, unchanged.

### Pairing and authority

- The pairing token is shared: the host has one `PairedClients` for both listeners, so the token works on the tailnet listener unchanged.
- First pairing is always over SSH, at Add host.
- The `remote-answer` grant (ADR-0025, Sept 29 amendment) is written only by the launch script over SSH. `mayAnswer` on the tailnet listener reads the same `PolicyStore`, so the grant carries over.
- A tailnet connection never asks for the grant. If `hello.mayAnswer` is false over the tailnet, the desktop sets `answersPending` and writes the grant at the next admin session. Nothing silent opens SSH.
- The tailnet adds no authority, and Serve identity headers are ignored (ADR-0004).

### Keeping desktops out of the phones list

Two things would put a desktop in the phones list:

1. redeeming any code at the tailnet `/v1/pair`, because `onPaired` adds the client to `phone-clients.json`;
2. pairing on the tailnet while phones are off.

Guards:

- The desktop pairs only on loopback (enforced client-side).
- The host refuses `/v1/pair` on the tailnet listener while phone access is off.
- While phone access is off and the listener is up for desktops, the host refuses `/v1/session` to clients in `phone-clients.json`.

### Host side of the tailnet connection

These changes are needed because the listener today exists only for phones.

- **New host setting `tailnetConnections`** (host-local, default off, set through a new admin route `/v1/admin/tailnet` over SSH). Serve runs while `phoneAccess || tailnetConnections` is on. Turning phones off no longer cuts desktops.
- **Features per client.** In hello, desktop clients (not in `phone-clients.json`) get `provider-sign-in` and `client-updates`; phones keep today's list. Health advertises everything the listener offers, and the desktop gates on hello's features. The sign-in and queue-update handlers check the peer, not the listener.
- **Fixes the tailnet connection makes visible:**
  - give each listener its own observation key (`socket-observations:<listener>`);
  - share the receipt map between both listeners, so a retried command survives a move;
  - count tailnet peers in `peersConnected`.

The admin listener is still never served (ADR-0050:19 stays true).

## 2. Start at boot

### Scope

| Platform | In scope? |
|---|---|
| Linux with a systemd user manager | Yes |
| macOS hosts | No. A LaunchAgent starts only at login, and a LaunchDaemon needs root. The host release is Linux-only (ADR-0025:27). |
| Windows hosts | No. The launch script is POSIX-only. |
| Linux without user systemd (WSL without systemd, containers) | No |

`boot-status` reports `unsupported` with one plain sentence in each out-of-scope case.

### Launch-script ops

Each op is added to the dispatch, the error allow-list, `LaunchOperation` and the sshLauncher ops.

- **`boot-status`** returns `{supported, installed, active, linger, nodeDrift}`. The launch op returns it too.
- **`boot-install`** does the following:
  1. Write `~/.config/systemd/user/sotto-host.service` and `<install>/boot-start.sh`.
  2. Run `systemctl --user daemon-reload` and `systemctl --user enable sotto-host`.
  3. Hand over a running host:
     - If the running host is owned: stop it (SIGTERM, 15 s drain), then `systemctl --user start`, then wait for discover. This restarts the host once, and the dialog says so.
     - If the running host is not owned: enable only. It takes effect at the next boot, and the dialog says that.
  4. Linger:
     - If off, run `loginctl enable-linger` without sudo. This is a per-user setting, and the owner has consented.
     - If polkit refuses, return `{linger:false, fix:'sudo loginctl enable-linger <user>'}`. Sotto shows that command and never runs sudo, the same precedent as ADR-0050:29.
     - Without linger the unit starts at first login, and the dialog says so.
- **`boot-remove`**: disable, stop, remove the files, then start a detached launch-script host so the switched-on host keeps running.

### The unit

```
[Service]
ExecStart=/bin/sh %h/.local/share/sotto-host/boot-start.sh
Environment=SOTTO_HOST_STARTED_BY=boot
KillMode=mixed
TimeoutStopSec=25
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
```

- `boot-start.sh` resolves `current` the way launchScript.ts:79-82 does, then runs `exec "<absolute node>" <entry> --data <data> --port <remotePort>`.
- It passes no `--key-file`, matching what a launch passes.
- The Node path is pinned. `update-install` rewrites the script when the probe finds a different Node, or when the new version needs a different Node range.
- `cliLookup`'s login-shell PATH fallback covers provider CLIs under systemd's minimal PATH.

### Lifecycle with a boot start

- **Ownership.** `startedBy: 'boot'` is a new accepted value (index.ts:36,188). `owned = startedBy ∈ {launch-script, boot}`.
- **Launch.** If the unit is enabled, launch never spawns a detached host. It runs `systemctl --user start` and waits, which avoids a lock race.
- **Stop host.** Runs `systemctl --user stop`. Copy: "forge's host stops now and starts again when forge restarts or when you switch it on."
- **Update restart.** Write `current`, run `systemctl --user restart`, then discover. To roll back, point `current` back and restart again.
- **Serve at boot.**
  - The host restores Serve from its own `phoneAccess` and `tailnetConnections` settings at start. The `--bg` Serve config also survives reboot in tailscaled, and the remembered port keeps it Sotto's.
  - Phone-access retry (30 s) widens: for the first 5 minutes after start it covers `missing` and Serve failures too. This covers user units, which cannot order after `tailscaled`.

## 3. Privacy, authority and docs

**ADRs.** 0051 is on main (#725) and #731 holds 0052, so these take 0053 and 0054. Check the numbering again at merge (`docs/agents/domain.md`).

- **ADR-0053**, "A desktop reaches a host over its tailnet first":
  - amends ADR-0025 (:25, :33, :42, :86 drop definition, :94 failure codes);
  - amends ADR-0050 (:19, which stays true; the tailnet listener now carries desktops and has the new setting and per-client features; :25, whose admin token now lives per admin session);
  - amends host-protocol.md :18 and :30.
- **ADR-0054**, "A host can start at boot on Linux":
  - amends ADR-0025:46 and :96 (`boot`);
  - amends ADR-0040:26 and :36 (systemctl restart);
  - amends the ADR-0050:33 consequence;
  - scopes out macOS and Windows hosts.

**README "Privacy and cost."**

- :90 adds: "With your consent, the host's Tailscale Serve also carries this computer's connection to it over your tailnet."
- :98 becomes "SSH hosts you add, and those hosts' own tailnet addresses".
- No new host is contacted: the address is the same machine on the owner's tailnet, and Funnel is never used.
- :28 stays true, because the grant is still SSH-only.

**guide.md.**

- :200 row strings.
- :202 Edit connection.
- :291-302 add: "With a tailnet connection, Tailscale SSH approval is asked only for Phones, Stop host, Update and Start at boot."
- :369 boot.
- :489 and :495 privacy.
- A new section, "Start at boot", covering the unit, linger, Stop and Remove.

**CONTEXT.md.**

- Add the five terms above.
- Amend Host :207, Pairing :217, Phone access :219 (tailnet listener), Launch script :221 (the forward is no longer the only long-lived ssh), and Switched on/off :249 (switching on starts the unit).

## 4. UI (prototype `docs/prototypes/host-tailnet-prototype.html`, using the existing ?variant/?state/?theme/?size harness)

Changed surfaces:

- row meta and status;
- Edit connection;
- the Add host checklist (new step "Reach forge over your tailnet" after Paired);
- Phones dialog: an approval state while its admin session connects;
- Stop host, Forget and Rename copy;
- update panel copy for `boot`;
- Tailscale row's missing-state line.

Three variants to prototype:

- **A. Row and menu.**
  - The meta prefix says `Tailnet` or `SSH forge`.
  - Edit connection gets a native radiogroup "How Sotto connects", above a "SSH (for setup, updates and phones)" fieldset:
    - "Over your tailnet, SSH when it can't" (default)
    - "SSH only"
  - The More menu gets **Start at boot…** or **Stop starting at boot…**, which opens a HostsModal. The modal says what changes on forge, that the host restarts once, and shows the linger command if needed.
- **B. Host dialog.** The row's name becomes a button opening "forge" (the ADR-0050 variant C precedent, as a dialog). It has three sections, each a check list like Phones:
  - Connection: tailnet address, last result, choice;
  - Start at boot: a switch, plus a linger/systemd check;
  - Phones: opens the existing dialog.

  Admin approval shows at the top.
- **C. Setup-led.**
  - Add host's checklist proves the tailnet connection. The connected card offers "Start forge's host at boot", one consented press.
  - Existing hosts get a one-time `HostSetupLine`-style line: "forge can connect over your tailnet and start at boot. Set up… / Dismiss". It reopens the same checklist.
  - The row stays as in A.

The pick is C for adoption plus A's controls, recorded in ADR-0053 (section 7). Every variant is checked at 1600×1000, 1280×800 and 820×560, in light and dark, and with reduced motion. Keyboard path: radios with arrows, the modal answers Escape, and focus returns to More.

**Questions that were open, decided in section 7:**

- Should the tailnet connection default on for new hosts? Yes.
- Should the boot offer show in Add host? Yes, on the connected card.
- Which row wording? Section 1's table.

## 5. PR plan

Dependency order: #735, then 1, then 2 and 3 (parallel), then 4, then 5, then 6, then 7 and 8.

1. **Decide how a desktop reaches a host over its tailnet and starts it at boot**
   - Branch: `feat/host-tailnet-adr`.
   - ADR-0053 and ADR-0054 as Accepted (section 7), the amendments to ADR-0025, ADR-0040 and ADR-0050, the prototype with variants A/B/C, the CONTEXT terms, and this plan. Docs only.
   - Ends with the owner's pick recorded.
2. **Let a host's tailnet listener carry desktops**
   - Branch: `feat/host-tailnet-listener`.
   - Files:
     - `src/host/index.ts` and `src/host/phones.ts` (setting, `/v1/admin/tailnet`, descriptor `tailnetAddress` and `startedBy`, foreground count);
     - `phoneAccess.ts` (Serve on when either setting is on; refuse phones and `/v1/pair` while phones are off);
     - `socketServer.ts` (per-peer features in hello, observation key, shared receipts, hello reports `startedBy` and `tailnetAddress`);
     - `launchScript.ts` (the launch result carries the address).
   - Tests:
     - `hostPhoneAccess.test.ts` with `standInTailscale`: phones off and desktops on means the phone session gets 401 and `/v1/pair` gets 403, while a desktop session gets the full features;
     - `socketServer` unit tests for the observation and receipt fixes;
     - `hostListener.test.ts` still asserts loopback only.
   - Docs: host-protocol.md and the ADR-0050 amendment.
3. **Keep the admin SSH apart from a host's socket connection**
   - Branch: `feat/host-admin-session`.
   - A refactor that changes no behaviour:
     - `LiveHost` gets `admin(): Promise<AdminSession>` (lazy, 60 s idle close);
     - `openSocket` takes `{url, expectedHostId}`;
     - phones, updates, stop, forget and cancelAdd go through `admin()`;
     - drops use setReconnecting then replace;
     - `SocketHostService` gates on hello features, and `pair()` is loopback-only.
   - Tests: `desktopHosts.test.ts` (threads survive a drop; an admin press opens one SSH session and reuses it), `hostPhones` and `hostUpdates` unit tests.
4. **Connect to a host over its tailnet before SSH**
   - Branch: `feat/host-tailnet-connection`.
   - Files:
     - `hostConnectionPlan.ts` (pure);
     - the tailnet store;
     - `HostStatus.via` and `tailnetNote`;
     - the 5-minute return check;
     - the `set-connection` command;
     - writes `tailnetConnections` on through an admin session when chosen;
     - `answersPending`.
   - Test seam: a `resolveTailnet` option on DesktopHosts, wired in main only for e2e (`SOTTO_E2E_TAILNET_MAP=forge.tail5728ca.ts.net=127.0.0.1:<port>`, guarded like `SOTTO_E2E_SSH_SCRIPT`), which lets plain http reach that one loopback mapping.
   - Tests:
     - unit tests of the plan table;
     - integration with `tests/fixtures/serveStandIn.ts`, a loopback proxy with upgrade support that sets `X-Forwarded-For` the way Serve does, in front of the real host's tailnet listener. Assert zero `FixtureSsh` connects on reconnect, fallback to SSH on 502 and 401, and moving back to the tailnet;
     - `describeHostServiceContract` run over the proxy;
     - e2e `host-tailnet.spec.ts`: add forge (fake ssh `run`), relaunch, then `FAKE_SSH_RECORD` shows no ssh; stop the stand-in to get `SSH forge · … Tailnet did not answer`; Phones… with `+tailscale` shows approval in the dialog.
   - Docs: the README privacy lines, guide :291-302, :489 and :495, and anything in ADR-0053 the build changed.
5. **Show how each host is connected in Settings > Hosts**
   - Branch: `feat/host-connection-ui`.
   - The picked variant: row copy, Edit connection choice, checklist step, Phones approval state. Update every exact string (hostsSettings.test.tsx :89/96/101/143, hosts/host-setup/host-agent-setup/host-provider-* specs).
   - Docs: guide :200 and :202. Verification note and captures in `artifacts/host-tailnet-connection/`.
6. **Let a Linux host start at boot**
   - Branch: `feat/host-boot-start`.
   - Files:
     - `launchScript.ts` (boot-status/install/remove, systemctl-aware launch/stop/update-restart, `boot-start.sh`, Node drift);
     - `src/host/index.ts` (`startedBy: 'boot'`);
     - the widened phone-access retry;
     - sshLauncher ops.
   - Tests: `sshLauncher` and launch-script integration with fake `systemctl` and `loginctl` executables on PATH, which record calls to JSONL and simulate missing linger, a polkit refusal and no user manager. Real systemd only in PR 8.
   - Docs: anything in ADR-0054 and its amendments to ADR-0040 and ADR-0025 the build changed, guide "Start at boot".
7. **Offer to start a host at boot from Settings > Hosts**
   - Branch: `feat/host-boot-start-ui`.
   - The picked placement, the consent modal with the linger command (copy button), Stop/Forget/update copy for `boot`.
   - Tests: unit and e2e with the fake systemctl through fake ssh `run`.
8. **Verify the tailnet connection and boot start on forge**
   - Branch: `chore/forge-tailnet-verification`.
   - `docs/verification/` note and artifacts. See section 6.

## 6. Risks and verification on forge

**Risks.**

- **Linux operator.** Serve needs `tailscale set --operator` on Linux. Until it is set the desktop stays on SSH with a plain note: "Tailnet did not answer: forge's Tailscale Serve needs `sudo tailscale set --operator=$USER`."
- **Unit Node path.** The pinned Node path drifts with mise upgrades. Mitigated by `boot-status.nodeDrift` and the rewrite at update.
- **Restarts.** Installing the unit restarts an owned host once.
- **TLS in CI.** Real TLS and MagicDNS cannot run in CI; only the forge check below proves the certificate path.
- **Token lifetime.** A stolen token now works from anywhere on the tailnet, not only through SSH. It still ends only by revoke, as today. This goes in ADR-0053.
- **Pacing.** The 32-peer cap and pacing are shared with phones.
- **Downgrade.** An older Sotto ignores `remote-host-tailnet.json` and keeps working over SSH.

**Verification on forge.** forge runs 0.1.30 under mise Node.

1. **Read-only checks first**, over `ssh -o BatchMode=yes forge`:
   - `tailscale serve status --json`;
   - `tailscale status --self --json`, keeping only the DNS name;
   - `loginctl show-user "$USER" -p Linger`;
   - `systemctl --user is-system-running`;
   - a `node -e` that prints only `startedBy`, `port` and `sottoVersion` from `~/.sotto/host-listener.json`. Never print `adminToken`.
   - If phone access is on, `curl https://<dns>:8443/v1/health` from Windows.
2. **Changes, each stated and approved by the owner before it runs.** Never stop forge's host or change its settings otherwise.
   - (a) Update forge's host through Sotto's Update. This restarts it. If it is not owned, the owner runs the shown commands.
   - (b) Turn on forge's `tailnetConnections`. This adds or keeps Sotto's Serve on its port.
   - (c) Start at boot. This writes the unit, may need the owner to run `sudo loginctl enable-linger zach`, and restarts the host once.
   - (d) Optionally, a forge reboot, at the owner's call.
   - Revert path: Stop starting at boot, then connect over SSH only.
3. **Proof.**
   - Relaunch Sotto with the Tailscale SSH check period lapsed. The row reads `Tailnet · Connected`, no approval page opens, and `Get-Process ssh` finds nothing.
   - Phones… asks for approval once.
   - After the reboot, forge's host comes back with `startedBy: boot`, and Sotto reconnects over the tailnet without SSH.
   - Captures go in `artifacts/forge-tailnet/`.

## 7. Decisions taken (owner's, delegated to the agent, October 5, 2026)

The owner said: "Go ahead and do everything we discussed, no need to stop and ask me ... babysit each PR until green, once green and you feel good merge." The open questions above were therefore decided as follows, and ADR-0053 and ADR-0054 record them as the owner's delegated picks:

- **UI variant:** C (setup-led) with A's controls. The row's meta line says `Tailnet` or `SSH forge` as in the table in section 1; Edit connection has the "How Sotto connects" radio group ("Over your tailnet, SSH when it can't" default, "SSH only"); the row's More menu has **Start at boot…** / **Stop starting at boot…** opening a consent modal; Add host's checklist gains the tailnet step and its connected card offers "Start forge's host at boot"; existing hosts get a one-time dismissible line offering to set both up.
- **Tailnet connection default:** on (prefer tailnet) for new hosts and for existing hosts once the host side is set up through that line or Add host.
- **Boot offer in Add host:** yes, on the connected card, one consented press.
- **Row wording:** as in section 1's table.
- **ADRs:** written as Accepted, not Proposed. Section 5's PR 1 is amended to match.
- **Forge:** read-only checks only, plus anything that touches nothing of the running host. Never stop, restart, update or reconfigure forge's running host or its Tailscale settings, never run sudo; the owner runs any command that needs it. Releases are cut by the owner by hand (docs/release/releasing.md); no agent cuts or publishes one.
