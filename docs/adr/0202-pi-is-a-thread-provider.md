# Pi is a thread provider

Accepted November 10, 2026. Pi is an Owl feature with Full access only, the user's own keyless model servers and Pi's own sign-ins. The first slice (#2421) implements own servers; the sign-in follow-up adds the existing Model sources surface to Pi. This amendment also replaces per-thread Pi config folders with one shared config and a per-thread tool gateway, for the credential reason below. The adapter was checked against Pi 1.5.2 from `@earendil-works/pi-coding-agent` (MIT). **Number provisional until merge.**

Pi joins Sotto's thread providers as `pi`, shown as **Pi**. It speaks Pi's native RPC, not ACP: `pi --mode rpc --session-dir <dir> --model <provider>/<model>`, in the thread's folder. One process belongs to one thread (ADR-0038). Commands have string IDs; their `response` records are matched by ID. Stdout is strict JSONL, split on LF alone, so U+2028 and U+2029 inside a JSON string survive. Stderr is drained and discarded. Neither stream, prompts nor credentials reach diagnostic logs.

## The gate and client

`pi` is in the Owl feature list and held-provider list (ADR-0072). Stable neither shows nor starts it and keeps its saved records whole. The shared CLI lookup finds `pi` (ADR-0036). `PI_CLI_VERSION` is 1.5.2, the oldest version tested, not a pin: newer clients run and show the verified version beside their own. Pi needs Node 22.19 or newer.

Updates follow ADR-0042. Sotto checks `@earendil-works/pi-coding-agent` on `registry.npmjs.org`. Only a copy npm owns is updated with Sotto's npm runner; other installations show `pi update` as a command to run by hand. On Windows the lookup reads npm’s package entry and starts that JavaScript file with the installed Node, without running a batch wrapper. A working thread keeps its process during an update and moves to the new client when idle. No runtime dependency is added to Sotto.

## Sotto's Pi folder

Sotto owns `<userData>/pi`. It never reads or writes the user's `~/.pi/agent`, copies its sign-ins, or adopts another provider's keys. This follows OpenCode's separate data folder (ADR-0087), Cursor, DeepSeek and Hermes: a Sotto thread must not change the settings of the Pi the user runs themselves.

`PI_CODING_AGENT_DIR` now names that one folder for auth commands and every thread. Pi owns its `auth.json`, including refresh and locking; Sotto stores only the IDs of sources signed in here, so it can name an expired or missing credential without reading it. Copying auth into each thread would leave stale refresh tokens. Linking auth files would add a Windows privilege requirement. One shared Pi auth file avoids both. Sessions keep their original `pi/threads/<hash of Sotto thread ID>/sessions` paths, so the first slice's conversations still resume.

Generated `models.json` comes from main's own-servers record (ADR-0124); the record remains the one truth. Shared `mcp.json` names one loopback Sotto gateway. Each process gets its own bearer token by environment interpolation. The gateway lists and routes only the Sotto tools given to that thread, with those servers' instructions and tokens. Failed optional servers add no tools and do not prevent a session. Revoking a thread cancels its outstanding gateway calls. Tokens stay in memory, never in generated files. Files are replaced whole. Changed model declarations outdate processes; working threads keep their process until idle.

The environment is an allow-list of ordinary process settings plus those explicit thread tokens. `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` and `PI_OFFLINE=1` disable Pi's version request, telemetry and model-catalog refresh. `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes` and `--no-approve` exclude personal discovery and project-local Pi configuration. **The one explicit extension is Pi's own `builtin:mcp`.** Pi 1.5.2 disables its built-in MCP with `--no-extensions` too; `-e builtin:mcp` restores only that upstream component, with direct tool exposure. This is not a Sotto-shipped extension. Ordinary AGENTS.md and CLAUDE.md context files remain enabled; Pi loads them regardless of project trust. Their words are context, never permission (ADR-0004).

## Models and permissions

The model menu groups models by where they run: own servers saved without a key, and each Pi model source signed in to inside Sotto. Models carry the record's context, output, image and thinking declarations. Unticked models stay available to existing threads but are hidden from new model choices, as for the other own-server providers. The model and thinking level are set before a prompt and checked through `get_state`. Main holds no copy of a keyed server's key, and Pi never reads OpenCode's or Hermes's credential stores.

**Full access is the only permission mode.** The menu says Pi does not ask before running tools, changing files or using the network. Pi has no built-in approval boundary; claiming Ask for approval would be false. Sotto produces no Pi approval cards and never synthesizes an approval. Sotto's own tools retain their own permission rules. This extends ADR-0004's existing rule that a user's Full access choice lets a provider act without raising requests; it does not turn project instructions into authority.

## Signing Pi in

Settings → Providers → Pi reuses OpenCode's **Model sources**, **Add a model source**, key field and browser/device-code dialog (ADR-0087), and the local provider-row precedent (ADR-0200). There is no new screen. Sign out runs `pi auth logout <source>` and confirms that `pi auth check --provider <source> --json` reports no credential before removing the row. A source whose retained sign-in no longer works says **Sign-in needs attention. Sign out and sign in again.** and offers no models. A send checks the source again before handing over the prompt; failed readiness keeps the draft.

Pi 1.5.2 rejects login over ordinary pipes. Sotto uses the existing `node-pty` dependency for a hidden terminal, runs `pi auth login <source> --api-key` or `--no-browser`, and reads only fixed progress shapes and approved HTTPS hosts. `--api-key` is a boolean: the key goes to its hidden-input prompt, never argv. Sotto never returns, logs or records raw terminal output, even if a client echoes input. Main holds sign-in URLs and codes only for the waiting attempt. The renderer receives the host name and device code; the existing Open the page action opens the full URL from main. Closing the dialog cancels a waiting process; attempts expire after 15 minutes. The key is kept only by Pi, not copied to Sotto's credential store. `check` may refresh an OAuth credential; Sotto never asks for `--credentials` or another credential-printing command.

Account paths checked live for progress and cancellation:

| Pi model source | Account path |
| --- | --- |
| Anthropic | Open its page, paste the code it gives back |
| GitHub Copilot | GitHub.com device code |
| Kimi For Coding, Meta, OpenAI Codex, Radius, xAI | Device code |
| OpenAI, OpenRouter | Browser page with a loopback callback |

All of those except OpenAI Codex also offer Pi's key/token path. Other single-key sources are Ant Ling, Baseten, Cerebras, DeepSeek, Fireworks, Google, Groq, Hugging Face, MiniMax and MiniMax CN, Mistral, Moonshot AI and Moonshot AI CN, NVIDIA, OpenCode Zen and Go, the four Qwen Token Plan variants, Together, TypeSafe, Vercel AI Gateway, Xiaomi and its three Token Plan regions, Z.AI and Z.AI Coding CN. This is a closed list from Pi 1.5.2, not a promise to accept a new provider's URLs on trust. A key is stored without testing a paid model call, as with OpenCode; rejection can first appear in the turn.

`PI_OFFLINE=1` stays set. Pi's bundled catalogue supplies the models and `get_available_models` supplies the signed-in subset; no background or post-login catalogue fetch is added. A source with no bundled models can be signed in, but says that none are listed and adds no menu entries. This deliberately trades the newest models and sources with only dynamic catalogues for no extra catalogue hosts. Updating Pi updates that bundled catalogue. Telemetry and version requests stay disabled too.

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

Extra cloud setup (Amazon Bedrock, Azure, Google Vertex AI and both Cloudflare services), GitHub Enterprise and pasted redirect-URL fallbacks for OpenAI/OpenRouter are not offered. These need more than the single-key and account paths covered here. Sources with only a dynamic catalogue offer no models while refresh is off. Native Radius MCP setup written by its login is replaced by Sotto's gateway declaration before a thread starts; only Sotto's tools are exposed.

**Approval requests.** A later Sotto-shipped Pi extension can intercept `tool_call` and use `ctx.ui.confirm` over Pi's RPC extension-UI subprotocol. That must be verified to block every relevant tool and route cancellation and answers correctly before a narrower mode is offered.

Steering, Pi-native follow-ups, manual compaction and native forks are not offered without live verification. Fork from here uses Sotto's existing handover path. Composer skills, short-text side calls (titles, branch names and Git drafts), Watcher and the Usage dashboard's numeric history are also absent. Per-turn token readouts do not claim complete billing history.

Remote hosts and phones are held off. Headless runtimes construct a held Pi host. Pi is included in the runtime's exhaustive thread-host registry; a desktop adapter answers the same on-demand session-hold read as other reaped providers, with busy/request/watched holds and its process ID. `provider-pi` is reserved for compatibility filtering, and clients that do not accept it receive no Pi rows or threads. No phone advertises it in this slice.

## Privacy and evidence

Client update checks use the already documented npm registry. A Pi thread reaches the selected own server or signed-in model source, plus the loopback Sotto tool gateway. Signing in and refreshing an account reach that source's own auth hosts. The README's Privacy and cost list names those hosts. No Pi telemetry, version, catalogue or package-discovery request is enabled. A Full access model may itself run network tools the user asked for; it is not a network sandbox. Pi's native session files contain the conversation inside Sotto's folder, as other providers keep their own sessions, while Sotto's diagnostic logs do not.

The fake Pi process and `piAdapter.test.ts` exercise the shared adapter contract, response correlation, streaming, Unicode framing, uncertain delivery, resume, process reaping and updates. `piLive.test.ts`, gated by `SOTTO_PI_LIVE`, exercises the actual adapter against a keyless Spark Cluster, including command and file tools, a native MCP call beside an unreachable MCP server, project instructions, streaming, token/context readouts, stopping a running tool, resuming its conversation and a model server that cannot be reached. No Sotto window is launched. Visual verification and the cross-platform gates belong to CI and a later in-app check.

The sign-in follow-up's `piSignInLive.test.ts` uses the installed Pi 1.5.2 in a scratch Sotto folder: synthetic OpenAI key entry, readiness, 44 discovered OpenAI models, sign-out, and all nine real account flows up to their page/code and cancellation. No account was signed in through a browser and no paid provider turn was made. Fixtures cover successful account completion, sign-out, expired credentials, a refused logout, draft preservation, and cancellation/expiry; unit checks cover the existing dialog and isolation between gateway tokens. The Spark adapter live checks still pass after the shared-folder change. Real account completion and desktop visual journeys remain manual verification, not claimed by fixture results.
