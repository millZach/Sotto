# Pi is a thread provider

Accepted November 10, 2026. Drake asked for Pi and chose an Owl feature, Full access only, the user's own keyless model servers and Pi's own sign-ins. This first slice implements the own-servers half; sign-in remains below under Not yet. The adapter was checked against Pi 1.5.2 from `@earendil-works/pi-coding-agent` (MIT). **Number provisional until merge.**

Pi joins Sotto's thread providers as `pi`, shown as **Pi**. It speaks Pi's native RPC, not ACP: `pi --mode rpc --session-dir <dir> --model <provider>/<model>`, in the thread's folder. One process belongs to one thread (ADR-0038). Commands have string IDs; their `response` records are matched by ID. Stdout is strict JSONL, split on LF alone, so U+2028 and U+2029 inside a JSON string survive. Stderr is drained and discarded. Neither stream, prompts nor credentials reach diagnostic logs.

## The gate and client

`pi` is in the Owl feature list and held-provider list (ADR-0072). Stable neither shows nor starts it and keeps its saved records whole. The shared CLI lookup finds `pi` (ADR-0036). `PI_CLI_VERSION` is 1.5.2, the oldest version tested, not a pin: newer clients run and show the verified version beside their own. Pi needs Node 22.19 or newer.

Updates follow ADR-0042. Sotto checks `@earendil-works/pi-coding-agent` on `registry.npmjs.org`. Only a copy npm owns is updated with Sotto's npm runner; other installations show `pi update` as a command to run by hand. On Windows the lookup reads npm’s package entry and starts that JavaScript file with the installed Node, without running a batch wrapper. A working thread keeps its process during an update and moves to the new client when idle. No runtime dependency is added to Sotto.

## Sotto's Pi folder

Sotto owns `<userData>/pi`. It never reads or writes the user's `~/.pi/agent`, copies its sign-ins, or adopts another provider's keys. This follows OpenCode's separate data folder (ADR-0087), Cursor, DeepSeek and Hermes: a Sotto thread must not change the settings of the Pi the user runs themselves.

Each thread gets a folder under `pi/threads/<hash of Sotto thread ID>`, named by `PI_CODING_AGENT_DIR`, with its sessions beneath it. Its generated `models.json` comes from main's own-servers record (ADR-0124); the record remains the one truth. Its `mcp.json` declares only the Sotto servers this thread was given. Their headers reference per-process environment variables. The bearer tokens stay in memory, never in those files. Separate folders prevent concurrent threads from replacing each other's tool-server URLs or credentials. Changing the own-servers record outdates processes whose declarations changed; idle threads resume on fresh processes.

The environment is an allow-list of ordinary process settings plus those explicit thread tokens. `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` and `PI_OFFLINE=1` disable Pi's version request, telemetry and model-catalog refresh. `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes` and `--no-approve` exclude personal discovery and project-local Pi configuration. **The one explicit extension is Pi's own `builtin:mcp`.** Pi 1.5.2 disables its built-in MCP with `--no-extensions` too; `-e builtin:mcp` restores only that upstream component, with direct tool exposure. This is not a Sotto-shipped extension. Ordinary AGENTS.md and CLAUDE.md context files remain enabled; Pi loads them regardless of project trust. Their words are context, never permission (ADR-0004).

## Models and permissions

Only servers saved without a key are offered in this slice, grouped by server in the model menu. Models carry the record's context, output, image and thinking declarations. The model and thinking level are set before a prompt and checked through `get_state`. Main holds no copy of a keyed server's key, and Pi never reads OpenCode's or Hermes's credential stores.

**Full access is the only permission mode.** The menu says Pi does not ask before running tools, changing files or using the network. Pi has no built-in approval boundary; claiming Ask for approval would be false. Sotto produces no Pi approval cards and never synthesizes an approval. Sotto's own tools retain their own permission rules. This extends ADR-0004's existing rule that a user's Full access choice lets a provider act without raising requests; it does not turn project instructions into authority.

## What a Pi thread can do in this first version

- Stream replies and thinking deltas, and show commands, file changes and other tool calls as activity.
- Send text, staged images to models whose record declares them, and file attachments by the existing attached-file path.
- Change models and thinking level; queue follow-ups through Sotto's queue.
- Stop a running turn: clear Pi's queues, then `abort`, whose response waits for idle. The turn finishes only on `agent_settled`, never `agent_end` or the prompt's acceptance response.
- Resume the same native conversation after a restart using its session ID and session folder. Sotto's event store keeps the displayed history (ADR-0016).
- Show per-turn token counts from assistant messages and context use from `get_session_stats`. Provider failures after acceptance become failed turns, with a plain instruction to check the model server. Pi's automatic retries and automatic compaction are disabled so neither silently extends a turn.
- Call Sotto's HTTP MCP tools with this thread's bearer token. A failed MCP connection does not prevent a Pi session from starting.

Its provider profile records those limits (ADR-0095).

## Not yet

**Pi sign-ins.** The intended home is Sotto's Pi folder, separate from the user's. Readiness can use `pi auth check --json --no-refresh` without `--credentials`; Sotto must never call the credential-printing commands. Pi 1.5.2's `auth login` and `auth logout` do not provide the JSON command-and-event dialogue suggested by `check --json`. Login has provider-specific browser, device and pasted-input flows, unlike OpenCode's structured model-source endpoints. The recent local Sign in precedent supplies a dialog and process lifecycle, but not a safe common parser or a model-source picker for Pi. This requires its own complete slice: source discovery, login/cancel/expiry, logout, model refresh, and shared auth across the isolated thread folders without copying stale refresh tokens. This PR exposes no half-working Sign in control and reads no personal sign-ins.

**Approval requests.** A later Sotto-shipped Pi extension can intercept `tool_call` and use `ctx.ui.confirm` over Pi's RPC extension-UI subprotocol. That must be verified to block every relevant tool and route cancellation and answers correctly before a narrower mode is offered.

Steering, Pi-native follow-ups, manual compaction and native forks are not offered without live verification. Fork from here uses Sotto's existing handover path. Composer skills, short-text side calls (titles, branch names and Git drafts), Watcher and the Usage dashboard's numeric history are also absent. Per-turn token readouts do not claim complete billing history.

Remote hosts and phones are held off. Headless runtimes construct a held Pi host. `provider-pi` is reserved for compatibility filtering, and clients that do not accept it receive no Pi rows or threads. No phone advertises it in this slice.

## Privacy and evidence

Sotto itself adds no host: client update checks use the already documented npm registry. A Pi thread reaches the selected model server's address and the loopback Sotto tool servers it was given. It makes no Pi telemetry, version, catalog, package-discovery or sign-in request. A Full access model may itself run network tools the user asked for; it is not a network sandbox. Pi's native session files contain the conversation inside Sotto's folder, as other providers keep their own sessions, while Sotto's diagnostic logs do not.

The fake Pi process and `piAdapter.test.ts` exercise the shared adapter contract, response correlation, streaming, Unicode framing, uncertain delivery, resume, process reaping and updates. `piLive.test.ts`, gated by `SOTTO_PI_LIVE`, exercises the actual adapter against a keyless Spark Cluster, including command and file tools, a native MCP call beside an unreachable MCP server, project instructions, streaming, token/context readouts, stopping a running tool, resuming its conversation and a model server that cannot be reached. No Sotto window is launched. Visual verification and the cross-platform gates belong to CI and a later in-app check.
