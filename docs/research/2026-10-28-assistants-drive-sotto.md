# Assistants that drive Sotto: Grok Bot and Hermes Agent

October 28, 2026. Zach asked how an outside assistant, Grok Bot or Hermes Agent, could connect to Sotto and drive it. The assistant would start and watch threads in projects, read status and replies, see what waits on Zach, steer and follow up, and report back wherever Zach talks to it, such as Grok Bot on his phone. Sotto exposes the interface. The assistant stays outside it, and Sotto neither hosts nor runs it. This note is research. It builds nothing.

Each claim is labelled. **Documented** means the vendor or project says it, and the page is named. **Observed** means I read it in source code or a raw file, and the file is named. **Inferred** means my reasoning from those. **Not verified** means I did not confirm it.

## Short answer

- **Grok Bot cannot reach Sotto today on a personal or Teams plan.** Its computers are Cursor-hosted cloud VMs. Remote MCP servers are called from Cursor's servers, so they must be public. The one documented private route, Tailscale or Cloudflare Tunnel installed by Team Setup Scripts, is Enterprise only.
- **Hermes Agent can reach Sotto today.** It is self-hosted, so it runs on a machine Zach owns, and it can call an MCP server over a tailnet or loopback with a header. Its own gateway (Telegram, Discord and others) can be Zach's phone front end.
- **Recommendation:** Design A, a narrow assistant profile on the desktop's tailnet listener, starting with Hermes. Grok Bot gets reports only (Design C) until Zach says whether his Cursor account is Enterprise. Do not build Design B, the relay.
- **The October 11 decision is touched.** Design A needs Hermes installed, which Oct 11 barred. See the next section.

## Where this touches the October 11 decision

The decision is at `watcher-bots.md:24` in the untracked October 11 notes: "No Hermes code and no Hermes install. Hermes and Grok Bot are references only." Its context, at line 17, is an option where Sotto is a client of a Hermes gateway on forge. "Zach does not like the outside dependency."

This direction reverses who depends on whom. Hermes would depend on Sotto, and Sotto would add no Hermes code and no Hermes dependency. The decision still applies in one place. Design A needs Hermes installed on forge or the laptop, and Oct 11 bars that install. Zach has to approve it. This note installs nothing.

Two more facts about the decision:

- The October 11 notes are untracked files in the primary checkout, `D:\Talk to Text Application\docs\research\2026-10-11-*.md`. No commit or branch holds them. `git log --all -S "no Hermes code"` finds nothing, so the decision exists only as uncommitted working text.
- Watcher's parked status stays as it is. Nothing here runs a bot inside Sotto.

## What Sotto exposes today

| Surface | Who reaches it | Auth | What it can do | Watcher only? |
|---|---|---|---|---|
| `sotto_threads` | The current Watcher thread, over loopback `127.0.0.1` | A 32-byte bearer per thread (`src/main/agents/threadToolServer.ts:61`) | Fifteen tools: watch, list, read, start, send, stop, settle and unsettle threads; projects, machines, working copies, state and operations (`src/shared/watcher.ts:284-409`). No answer, approve or policy tool. | Yes. `src/main/agents/watcherTools.ts:95-106` returns nothing to other threads. |
| `sotto_visual` | Threads on this host that take Sotto's tools | Per thread | `visualize`: a sealed page with `connect-src 'none'` (`src/main/agents/visualPagePolicy.ts:10-11`) | No. Watcher gets no visual tool (ADR-0073, ADR-0152). |
| Remote host socket (phones) | Paired clients, over the tailnet or SSH | An 8-character pairing code, then a 32-byte token (`src/main/agents/pairing.ts:139`), then a 12-hour signed session (`pairing.ts:21`) | The remote command allow-list (`src/host/remoteCommands.ts:20-87`): send, steer, interrupt, start threads on the default mode, settle, Git and pull-request actions including merge, observe. `answer` needs a `remote-answer` record (`remoteCommands.ts:138`). | No |
| Admin routes | Loopback or SSH only | A per-process admin token (`src/host/socketServer.ts:387`) | Pair and revoke clients; turn phone access on | No |
| SSH desktop grant | The authenticated SSH account only | Written by the launch script (`src/main/hosts/launchScript.ts:500-516`) | One `remote-answer` allow record for that desktop. ADR-0025, September 29 amendment: "Zach chose automatic desktop authority when setting up a remote PC." | No |

What an assistant could reuse: the pairing and session path, revoke, the remote allow-list, the attribution written with each answer, and the router that already joins every connected host's threads (`src/main/hosts/`).

## Safety rules, as the code holds them today

| Rule | Code today | Gap |
|---|---|---|
| Never answer a permission or question for the user | Answering needs a `remote-answer` record (`control.ts:5183-5186`, `remoteCommands.ts:186`). Wake-up turns cannot answer (`control.ts:5215`). Watcher has no answer tool. | `control.ts:5216-5220` computes the risky-action verdict and discards it. Its comment says the user's Allow is the confirmation. So a client holding `remote-answer` gets Allow without a check. An assistant must never hold that record. |
| One merge at a time | Not in code. It appears in CONTEXT.md's "Merge turn" entry and in docs. | `git-pull-request-action` is on the remote allow-list (`remoteCommands.ts:69`) and is not gated by policy (`remoteCommands.ts:138`). Its case in `control.ts:3350-3356` has no grant check. The comment at `remoteCommands.ts:67-68` says merging takes "the surface's confirmation first". I did not find where that confirmation happens in code. |
| Audit of who did what | An answer writes the request, the choice and the client identity to the thread log, and leaves out the words (`control.ts:5192-5209`). A failed write logs only a stable name. | Other remote commands are not audited this way [not verified]. |
| Revocation | `pairing.revoke`, `/v1/revoke` and admin `revoke-client`. Open sockets are closed (`src/main/agents/pairing.ts:185`, `src/host/socketServer.ts:1516`). | Client tokens never expire. The only expiries in `pairing.ts` are the five-minute pairing code and the 12-hour session. |

Two rules apply from the assistant's side. First, Sotto cannot control what an assistant does with its own approvals. Hermes decides those, so Sotto's endpoint must refuse answers and merges by construction, whatever the client is set to. Second, Hermes's write prompts are a client setting, not a Sotto one (see Hermes below). Sotto should not rely on them.

## Grok Bot: what the primary sources say

These come from cursor.com and docs.x.ai, read on 2026-10-27. Pages marked "summary" came through a summarised fetch and were not checked against the raw page.

- **Where it runs.** "Grok Bot runs only on Cursor-hosted cloud computers." There is no self-hosted option. [documented, cursor.com/docs/grok-bot/private-networks.md]
- **MCP.** Users add servers under Connect apps. Admins choose which servers members may use on the Team Marketplace, at cursor.com/dashboard/plugins. [documented, cursor.com/docs/grok-bot/teams.md; Connect apps page, summary] No Grok Bot config keys or transport list are documented. The Cloud Agents page says "Both HTTP and stdio transports are supported", but that is a different product. [documented, cursor.com/docs/cloud-agent.md]
- **The routing rule that decides it.** "Remote MCP servers are called from Cursor's servers. Command servers run on the Bot's computer." [documented, cursor.com/docs/grok-bot/security.md] So a Sotto endpoint on a tailnet cannot be a remote MCP server for Grok Bot. Two routes remain: a public URL, which Sotto must never have, or a command (stdio) MCP server on the Bot's computer that dials Sotto over a tailnet.
- **The tailnet route.** Team Setup Scripts can install Tailscale, as an exit node, or `cloudflared` on each team computer. The scripts run as the computer user with `sudo`, with a 30-minute timeout per entry. "Cursor installs nothing by default." This is Enterprise only. [documented, private-networks.md] Both clients connect outward, and no inbound listener is described.
- **Route through this computer.** This sends the Bot's web traffic out through a desktop, and "doesn't open your private network to the Bot." [documented, private-networks.md]
- **Egress.** Shared static IPs; "dedicated per-customer IPs are not available." [documented, security.md] No Grok Bot range is in `cursor.com/docs/ips.json`, which has only `cloudAgents` and `gitEgressProxy` keys. [observed]
- **Network controls.** Allowlists are Enterprise only. "Teams without a policy default to allow-all." [documented, summary]
- **Auth, Bot to user endpoints.** Connector OAuth tokens stay on Cursor's backend, and "Bots invoke tools without receiving them." [documented, security.md] Team Secrets allow up to 100 per team, 32 KB per value and 96 KB in total, and scripts read them as environment variables. [documented, teams.md] No documented way exists for a Bot to call an arbitrary endpoint with an auth header [not verified].
- **Auth, caller to Bot (Routines).** A POST to the routine's URL with `Authorization: Bearer <key>`. The JSON body reaches the Bot with the routine's instruction. A 200 means the run started, not that it finished. Any other response means no run started. [documented, cursor.com/help/grok-bot/routines] Limits: 300 runs an hour in total and 200 per routine. A run over a limit fails and is not retried. A Bot holds up to 50 routines and keeps the 20 newest run records per routine. [documented, routines; docs.x.ai/grok-bot/skills-routines-and-automations]
- **Approvals on unattended runs** expire after about 30 minutes. [documented, cursor.com/help/grok-bot/how-to]
- **Not documented:** timeouts, concurrency, payload size, key rotation, who else may call the webhook, and whether a run's reply reaches Zach's Bot chat or any caller. [not verified]
- **Cursor Automations** is a different product. Its webhook is "a private HTTP endpoint", and its header format and limits are not documented. [documented, cursor.com/docs/cloud-agent/automations.md]
- **Identity.** SAML 2.0 single sign-on. SCIM is Enterprise only. [documented, docs.x.ai/grok-bot/identity-and-access.md]

What this means: Grok Bot can reach Sotto only through an Enterprise tailnet route or a public relay. Sotto can reach Grok Bot through a routine webhook, but that call returns no result.

## Hermes Agent: what the primary sources say

The repository is github.com/NousResearch/hermes-agent (MIT). I read it at commit `19949783`, with docs at hermes-agent.nousresearch.com. The latest release is v0.22.5 (2026-10-23). I installed and ran nothing. The Hermes research read source through a summarised fetch of raw files. Where I checked a claim against the raw file, I say so.

- **Where it runs.** Native Windows without WSL, Linux, WSL2 and Apple silicon macOS. [documented, README and installation page] Python: the docs say 3.14, and `pyproject.toml` allows 3.11 to 3.14 [observed]. Docker is optional.
- **MCP.** Servers go under `mcp_servers` in `~/.hermes/config.yaml` (on Windows, under `%LOCALAPPDATA%\hermes`). The keys include `url`, `headers`, `transport`, `trust`, `tools` (`include`, `exclude`) and `enabled`. [documented, features/mcp] Over a URL, Hermes tries Streamable HTTP first and falls back to SSE. [observed, `tools/mcp_tool_transport.py`] The commands are `hermes mcp add`, `configure` and `test`, plus `/reload-mcp`. None adds a custom URL server, so a custom server is a config edit [inferred].
- **Trust.** `trust: untrusted` prompts before write-capable calls to that server. `trust: full` runs them without asking. The docs do not say what a missing key means. The raw source does: `None -> full (compat default); unrecognized -> untrusted (fail closed)`. [observed, `tools/mcp_tool_registration.py`, `_normalize_server_trust`, checked against the raw file] So a Sotto entry with no `trust` key runs its write tools without asking.
- **Approvals.** `approvals.mode` defaults to `smart`. An auxiliary model judges each dangerous command. Low-risk commands are auto-approved, dangerous ones are auto-denied, and uncertain ones go to a human prompt. `off` also runs write calls on untrusted MCP servers without the trust prompt. [documented, security page] Unattended sessions (webhook, API server) deny dangerous commands by default. [documented, security page]
- **Borrowed logins.** `auth.adopt_external_logins` defaults to true, so Hermes reads and refreshes `~/.codex/auth.json` and `~/.claude/.credentials.json`. [documented, security page] On a laptop, Hermes could act with Zach's Codex and Claude logins unless he sets it to false.
- **Gateway.** About twenty platforms, including Telegram, Discord, Slack, WhatsApp, Signal, email, SMS, Matrix and Teams. Allowlists deny by default. An unknown direct message gets a pairing code, approved with `hermes pairing approve`. [documented, messaging and security pages] Messaging toolsets include "full tools including terminal." [documented] Whether a trust prompt for an MCP server reaches the chat is [not verified].
- **Daemon.** `hermes gateway install` registers a systemd user service on Linux and launchd on macOS. The messaging page also names a Windows logon task, which the CLI reference does not list. The two docs conflict. [documented]
- **Outbound hosts by default.** These belong to Hermes, not Sotto.
  - `api.github.com`: a passive update check at CLI start. [documented] The switch that turns it off, `updates.check: false`, appears only in source. [observed]
  - `api.osv.dev`: before a stdio server launched by `npx`, `uvx` or `pipx`, Hermes sends the package name and version for a malware lookup. It fails open after 10 seconds. The pages I read do not mention it. [observed, `tools/osv_check.py`, checked against the raw file]
  - `portal.nousresearch.com` and `nousresearch.com`: Nous Portal sign-in, and the Tool Gateway for search, images, speech and browser work. [documented]
  - Model metadata and provider endpoints, and Firecrawl cloud for web search. [documented; the Firecrawl host was not checked]
  - Telemetry: none documented. `hermes debug share` uploads only when someone runs it by hand. [documented]

Hermes's default hosts matter for Zach's privacy line only if Hermes runs on his machine. Sotto's README does not list them, and it should not list them as Sotto's.

Two corrections to the October 11 notes:

- The Hermes note says the bot-mode warm backend has a limit of three and a ten-minute idle reaper. The current page says there is no limit setting and no idle reaper. [documented, bot-mode page] The note also missed the MCP `trust` default and the OSV lookup.
- The Grok note says unattended approvals expire after about ten minutes. The current doc says about thirty. Its plan mapping is stale. It missed Team Setup Scripts, the Team Marketplace, the routine limits and the rule that a 200 means started.

## Designs

### Design A: an assistant profile on the desktop's tailnet listener (recommended)

A second MCP endpoint, served by the desktop through Tailscale Serve. This is the route phone access already uses (ADR-0033, ADR-0050). Its tools are a fixed list drawn from Watcher's set: list and read threads, read state (including what waits on Zach), start, send, stop, settle, watch, and list projects and machines. It has no answer, approve, policy, delete, permissive-mode, merge or close tool. Each assistant is a paired client of a new kind, with its own token and its own 12-hour session. It gets no `remote-answer` record, which only the SSH desktop's launch script can write (ADR-0025). Zach starts pairing with the eight-character code shown on the desktop, and gives it to the assistant. Hermes connects with `url` and `headers`, and sets `trust: untrusted` so it asks before any write.

- **For.** It reuses pairing, sessions, revoke, attribution and the router. It adds no host. Sotto enforces "no answers" itself, so a permissive client still cannot answer. Hermes's gateway gives Zach his phone surface.
- **Against.** It is a new outward listener and a new tool gate outside Watcher's. It needs an ADR, amending ADR-0073 or a new one, and a README entry. Pairing refuses tailnet clients while phone access is off (`src/host/socketServer.ts:57`, `:348`), so that rule would need a deliberate change. Assistant tokens need an expiry, which client tokens do not have today. Grok Bot cannot use it without an Enterprise tailnet route.
- **Cost.** Medium. The handlers exist. The gate, the profile, the token kind and the listener are new.

### Design B: a relay for Grok Bot

Zach runs a small relay on his own Cloudflare account. Grok Bot routines POST commands to it. Sotto pulls them outbound on a timer and posts replies back. Grok reads replies from the Bot's shell or a second routine. Sotto never accepts an inbound connection.

- **For.** It works without Enterprise, if the Bot's shell can reach the relay [not verified].
- **Against.** It adds a host, and thread content passes through it. That needs an ADR, a README entry and end-to-end encryption, so the relay cannot read what it carries. A routine returns only "started", so replies wait on polling. The Bot's reach to the relay is unverified. Two systems have to stay in step.
- **Cost.** High.

### Design C: reports only, no inbound

Sotto posts a short status to a Grok Bot routine when something needs Zach, such as a request waiting or a thread finished. There is no command path back. Zach steers Sotto through Hermes or at the desktop.

- **For.** It is the smallest option. It opens no inbound surface, and Sotto sends only what the report says.
- **Against.** It does not meet "drive". The outbound call goes to a new host, Cursor's routine endpoint, which needs an ADR and a README entry. It gets no result back, and whether the reply reaches Zach's Bot chat is not verified.
- **Cost.** Small.

**Recommendation.** Design A, starting with Hermes on forge. Hermes is self-hosted and needs no Enterprise plan, and its gateway is Zach's phone surface. Use Design C for Grok Bot until Zach says whether his Cursor account is Enterprise. If it is, Grok Bot can join through a Tailscale setup script and a small stdio MCP bridge, which is Design A with a different client. Do not build Design B. It adds a host and puts thread content on a third party's relay.

Hermes on forge is an inference [inferred]. Forge is always on, Hermes runs natively on Linux, and the headless host already lives there (ADR-0050). Where Sotto's projects live is a separate question for Zach.

## Safety rules under each design

| Rule | Design A | Design C | Design B |
|---|---|---|---|
| Never answer for the user | The profile has no answer tools. Assistant clients never get `remote-answer`. Sotto refuses server-side, so a permissive client cannot change this. | No command path, so nothing answers. | The relay carries commands, so the Sotto side must refuse answers the same way. |
| One merge at a time | Merge and close are excluded in v1. Any later merge needs a merge lock in code, which does not exist today. | Not applicable | Same as A |
| Audit | Stamp every assistant command with its client identity and request, as answers are stamped today. Leave prompt text out, as AGENTS.md requires. | Reports logged on Sotto's side | Both the relay log and Sotto's log are needed. |
| Revocation | Assistant tokens get an expiry, and revoke from the Hosts page. | Revoke the Bot's webhook key. | Revoke the relay key and the Bot's secret. |

## Open questions for Zach

1. **Install.** May Hermes be installed on forge, or on the laptop, as an outside client? October 11 said no install, and Design A needs one.
2. **Machine.** Should Hermes run on forge or the laptop? On the laptop it would read Zach's Codex and Claude logins unless `auth.adopt_external_logins` is set to false.
3. **Grok Bot plan.** Is the Cursor account on Enterprise? If not, is Design C enough for now?
4. **Merges.** Should an assistant ever merge? This note recommends no, not in v1.
5. **Starts and sends.** Should an assistant start threads, or only send to threads it can already see? Starts would run under the user's requests, with a bound.
6. **Phone front end.** Which Hermes gateway, Telegram, Discord or another? Who goes on its allowlist?
7. **Token lifetime.** How long should an assistant's token last before it expires?
8. **Outbound report.** Is a report to a Grok Bot routine a new host? If so it needs an ADR, and Zach must say what it may contain.
9. **October 11 notes.** Should the three notes be committed, so the decision is in git, or kept local?
10. **Owl or stable.** When this is built, is it an Owl feature or straight to stable? CLAUDE.md asks this before any new feature.

## Verification

Checked by me against source or raw files:

- Hermes `trust` default, against the raw `tools/mcp_tool_registration.py`.
- The Hermes OSV lookup, against the raw `tools/osv_check.py`.
- Sotto: `control.ts:3350-3356`, `control.ts:5183-5186`, `control.ts:5216-5220`, `launchScript.ts:500-516`, `remoteCommands.ts:67-69` and `:138`, and the ADR-0025 September 29 amendment.
- The October 11 quote at `watcher-bots.md:24` and line 17.

Line numbers are for `origin/main` at `23a81ecfc`.

Not verified: the chain past `gitCommand` for pull-request actions, which is where merge confirmation would happen if it exists; the full argument schemas beyond list and read; where the iPhone stores its token; the Grok Bot pages marked "summary"; whether a Grok routine's reply reaches Zach's chat; whether Hermes trust prompts reach the gateway chat; the Hermes Windows daemon; and whether Hermes's smart approval covers MCP calls.

## Sources

Primary sources, as read on 2026-10-27 unless noted.

Grok Bot and Cursor:
- cursor.com/docs/grok-bot/security.md, private-networks.md, teams.md
- cursor.com/help/grok-bot/routines, connect-apps, how-to, plans, secrets
- cursor.com/docs/cloud-agent.md, cloud-agent/self-hosted.md, cloud-agent/security-network.md, cloud-agent/automations.md
- cursor.com/docs/ips.json (dated 2026-05-29)
- docs.x.ai/grok-bot/identity-and-access.md, skills-routines-and-automations, security-faq, inference-hooks
- docs.x.ai/grok/connectors/custom-mcp-tunneling (dated 2026-10-10; it covers grok.com connectors, and whether it applies to Bot is not verified)

Hermes Agent:
- github.com/NousResearch/hermes-agent at `19949783`: README, `tools/mcp_tool.py`, `tools/mcp_tool_registration.py`, `tools/mcp_tool_transport.py`, `tools/osv_check.py`
- hermes-agent.nousresearch.com/docs/user-guide/features/mcp, user-guide/security, user-guide/messaging, user-guide/configuration, user-guide/bot-mode, getting-started/installation, reference/cli-commands

Sotto (repo paths, at `origin/main` `23a81ecfc`):
- `src/main/agents/threadToolServer.ts`, `watcherTools.ts`, `pairing.ts`, `control.ts`, `visualPagePolicy.ts`
- `src/shared/watcher.ts`
- `src/host/remoteCommands.ts`, `socketServer.ts`
- `src/main/hosts/launchScript.ts`
- docs/adr/0025, 0033, 0050, 0073, 0152
- The October 11 notes, untracked, in the primary checkout
