# Cursor CLI: driving the agent from another program

Research date: 2026-10-23. Sources are Cursor's own pages (cursor.com/docs and the install scripts) and the CLI changelog. Secondary sources were not used.

Version at the time of research: CLI `2026.10.22-27dcf5f`. Both install scripts name this build. The docs pages carry no date of their own. Dates below come from the CLI changelog headings or the page itself.

This note records facts only. It makes no decision. Adding Cursor as a thread provider needs an ADR, a README change for any new host, and a decision on approvals.

## Summary

- **Binary.** `agent` is the primary name. `cursor-agent` is kept as a legacy alias.
- **Windows.** Native Windows is supported through a PowerShell installer. WSL is also supported.
- **Recommended protocol: ACP.** Run `agent acp` and speak JSON-RPC 2.0 over stdio. ACP is the only documented path where the agent asks for permission over the protocol (`session/request_permission`). It also has `session/new`, `session/load`, `session/prompt`, `session/cancel` and streamed `session/update` notifications. Sotto already speaks ACP to Grok and Devin.
- **Print mode with stream-json fits one-shot side calls.** `agent -p --output-format json` suits titles, branch names and drafts. It has no approval channel.
- **Not documented, or not supported over the protocol:**
  - fork (only the interactive `/fork` command);
  - permission prompts in print mode;
  - an effort flag (effort is picked by model slug);
  - usage and cost fields in the documented event schemas;
  - setting the mode or the model over ACP.
- **Not installed on this machine.** Neither `agent` nor `cursor-agent` is on PATH. Appendix A has the checks.

## 1. Install and binaries

- macOS and Linux (and WSL): `curl https://cursor.com/install -fsS | bash`. Source: installation page and `cursor.com/install`.
- Windows native: `irm 'https://cursor.com/install?win32=true' | iex`. Source: installation page and `cursor.com/install?win32=true`.
- The bash script rejects Windows with "Unsupported operating system". The PowerShell script downloads `windows/<x64|arm64>/agent-cli-package.zip`. Checked 2026-10-23.
- Linux and macOS install to `~/.local/share/cursor-agent/versions/<version>/`. They create symlinks `~/.local/bin/agent` and `~/.local/bin/cursor-agent`. The script does not edit PATH. It prints the export line for the user to add.
- Windows installs to `%LOCALAPPDATA%\cursor-agent\versions\<version>`. It copies `cursor-agent.exe`, `.cmd` and `.ps1` to `%LOCALAPPDATA%\cursor-agent`, then copies them again as `agent.exe`, `agent.cmd` and `agent.ps1`. It adds `%LOCALAPPDATA%\cursor-agent` to the user PATH.
- The Windows installer deletes an existing `%LOCALAPPDATA%\cursor-agent` folder before it installs. Any content in that folder is lost. Checked in the script, 2026-10-23.
- Updates: `agent update` or `/update`. The CLI auto-updates by default. The `channel` config key picks the release channel. Source: installation page and configuration page.
- Git for Windows is needed only for `agent worker start` on Windows (changelog v2026.10.15, Oct 15 2026). It is not needed for interactive or print use.
- The Windows uninstaller can delete `~/.cursor`, which holds CLI credentials (changelog v2026.08.11, Aug 11 2026).
- The Windows shell tool runs PowerShell and writes UTF-8 (changelog v2026.10.22, Oct 22 2026). The agent no longer uses tmux for shell on Windows (changelog v2026.10.15).

## 2. Print mode and stream-json

Source: `cursor.com/docs/cli/reference/output-format.md`, `cursor.com/docs/cli/headless.md`, `cursor.com/docs/cli/reference/parameters.md`.

- Flag: `-p, --print`. Output format: `--output-format <text|json|stream-json>`. Default is `text`. The flag works only with `--print`.
- `--stream-partial-output` works only with `--output-format stream-json`. It emits text deltas.
- `thinking` events are suppressed in print mode.
- Print mode has full tool access, including write and shell (parameters page).

Format `json`: one object, written at the end.

```
{"type":"result","subtype":"success","is_error":false,"duration_ms":...,"duration_api_ms":...,"result":"...","session_id":"<uuid>","request_id":"<optional>"}
```

Format `stream-json`: NDJSON, one event per line. Event types on the reference page:

- `system` with `subtype: "init"`. Fields: `apiKeySource` (`env|flag|login`), `cwd`, `session_id`, `model` (display name), `permissionMode` (`"default"` in the example). The page says `tools` and `mcp_servers` may be added.
- `user`. `message.content[]` with `type: "text"`, plus `session_id`.
- `assistant`. `message.content[]` with `type: "text"`, plus `session_id`. With `--stream-partial-output` it may also carry `timestamp_ms` and `model_call_id`. Deltas have `timestamp_ms` and no `model_call_id`. The buffered flush before a tool call has both. The final flush at end of turn has neither. Consumers use only the deltas.
- `tool_call` with `subtype` `started` or `completed`, plus `call_id`. The `tool_call` object holds `readToolCall` (`args.path`; on completion `result.success` with `totalLines`, `content`), `writeToolCall` (`args.path`, `fileText`, `toolCallId`; on completion `result.success` with `path`, `linesCreated`, `fileSize`), or `function` (`name`, `arguments`) for other tools.
- `result` with `subtype: "success"`, `is_error: false`, `duration_ms`, `duration_api_ms`, `result` (full text), `session_id`, optional `request_id`.

Failure: the process exits non-zero, writes to stderr, and the stream may end with no `result` event. The page documents no error event type.

Two notes on the stream:
- The docs say every event carries `session_id`.
- The February 2026 changelog says stream-json has "per-turn input/output/cache token totals and a request_id". The reference page shows `request_id` only. See section 8.

## 3. ACP (Agent Client Protocol)

Source: `cursor.com/docs/cli/acp.md`. The method names come from the ACP spec, `agentclientprotocol.com/protocol/schema`.

- Start: `agent acp`. It is hidden from default `--help` (parameters page). Root flags can go before `acp`: `--api-key` (or `CURSOR_API_KEY`), `--auth-token` (or `CURSOR_AUTH_TOKEN`), `-e <endpoint>`, and `-k` (TLS; the page does not explain it). Example endpoint: `https://api2.cursor.sh`.
- Framing: newline-delimited JSON-RPC 2.0 over stdio. Requests and notifications go to stdin. Responses and notifications come from stdout. Logs go to stderr.
- Flow the page documents:
  1. `initialize` with `protocolVersion: 1` and `clientCapabilities`.
  2. `authenticate` with `methodId: "cursor_login"`.
  3. `session/new` with `cwd` and `mcpServers`. Returns `sessionId`.
  4. `session/load` to resume an existing conversation.
  5. `session/prompt` with `sessionId` and `prompt: [{type:"text", text}]`. Returns `stopReason`.
  6. `session/update` notifications while the model streams. The example reads `sessionUpdate: "agent_message_chunk"` and `content.text`.
  7. `session/request_permission`. The client returns a decision.
  8. `session/cancel` (optional).
- Permission replies: the page lists `allow-once`, `allow-always` and `reject-once`. Its example returns `{ outcome: { outcome: "selected", optionId: "allow-once" } }`. The ACP spec uses `allow_once`, `allow_always`, `reject_once` and `reject_always` for option kinds. It returns `selected` with an `optionId`, or `cancelled`. Read the `options` array in the request and answer with one of its `optionId` values. Do not hard-code the names. If the client never answers, tool execution can block.
- Blocking Cursor extension methods. The agent waits until the client answers:
  - `cursor/ask_question` (answers: `answered`, `skipped`, `cancelled`).
  - `cursor/create_plan` (answers: `accepted`, `rejected`, `cancelled`).
- Notification Cursor extension methods. No reply needed:
  - `cursor/update_todos`;
  - `cursor/task` (subagents);
  - `cursor/generate_image`.
- Clients that advertise a `subagents` capability get subagents as child sessions. Other clients get `cursor/task` (changelog v2026.09.15, Sep 15 2026).
- Background shells that watch for output keep the prompt open until the output matches. Cancelling or sending a new prompt ends the wait (changelog v2026.10.08, Oct 8 2026).
- If the user switches team while the ACP server runs, `session/new`, `session/load` and `session/prompt` fail. The server then exits (changelog v2026.10.08, Oct 8 2026).
- MCP servers come from `.cursor/mcp.json` in the project or `~/.cursor/mcp.json`. Team MCP servers set in the dashboard are not supported in ACP mode.
- Modes: `agent`, `plan` and `ask`. The ACP page does not name a method for switching them. The ACP spec does define `session/set_mode`. Whether Cursor implements it is not documented.
- Model: the ACP page documents no way to pick a model. `session/set_model` is not in the ACP spec's agent method list that I read. The global `--model` flag is documented for root commands. Whether it works before `acp` is not documented.
- Capabilities: the page does not list what the agent advertises at `initialize`. Whether `loadSession` is advertised is not documented.
- The example client declares `fs` and `terminal` as `false`. The page does not say what the agent does when a client advertises them.
- Only `agent_message_chunk` is shown in `session/update`. The page does not say whether tool-call updates use the ACP spec's `tool_call` and `tool_call_update` forms.
- ACP clients named on the page: JetBrains IDEs, Zed (spawns `agent acp`), and avante.nvim (`command = ~/.local/bin/agent`, `args = {"acp"}`, `auth_method = "cursor_login"`).

## 4. Sessions

Sources: parameters page, using page, overview page, slash-commands page, output-format page.

- `agent ls`: lists previous chats and opens one to resume.
- `agent resume`: resumes the latest chat.
- `agent --continue`: continues the previous session. Alias for `--resume=-1`.
- `agent --resume [chatId]` (global option): resumes a chat. The using page says it "loads prior context". The docs do not say whether `-p --resume` works. The Sep 28 2026 entry (v2026.09.28) mentions resumed sessions but not print mode.
- `agent create-chat`: creates an empty chat and prints its ID (parameters page). This gives a chat ID before the first prompt.
- `/fork`: forks the current chat (interactive slash command only). No flag or ACP method is documented for fork.
- `/rename <name>`: renames the current chat.
- `agent persist` (changelog v2026.08.26, Aug 26 2026): starts a persistent session that keeps running after disconnect. Also `/detach`, `agent persist attach`, `agent persist list|stop`, and `agent persist --resume`. This is in the changelog only. The parameters page does not list `persist`.
- Session IDs. In stream-json and json output: `session_id` in each event. In ACP: `sessionId` in the `session/new` reply. Interactive: `/copy-conversation-id`.
- Worktrees: `-w, --worktree [name]` runs in a new git worktree under `~/.cursor/worktrees/<repo>/<name>`. `--worktree-base <branch>` sets the base. `--workspace <path>` sets the repository root.

## 5. Permissions and approvals

Sources: permissions page, configuration page, parameters page, headless page, using page, run-modes page (`cursor.com/docs/agent/security/run-modes.md`), hooks page (`cursor.com/docs/hooks.md`).

Flags (parameters page):
- `-f, --force` / `--yolo`: "Force allow commands unless explicitly denied."
- `--approve-mcps`: approves all MCP servers automatically.
- `--trust`: trusts the workspace without a prompt. The parameters page says headless only. Changelog v2026.07.20 (Jul 20 2026) says it also works in interactive sessions.
- `--sandbox enabled|disabled`.
- `--mode plan|ask`, `--plan`, and `--mode=ask` for read-only.

Config files:
- Global: `~/.cursor/cli-config.json` (Windows: `%USERPROFILE%\.cursor\cli-config.json`).
- Project: `<project>/.cursor/cli.json`. Only permissions can be set at project level.
- Required fields: `version` (1), `editor.vimMode`, `permissions.allow`, `permissions.deny`.
- `approvalMode`: `allowlist`, `auto-review` or `unrestricted`.
- `autoAcceptWebSearch` (changelog v2026.07.13, Jul 13 2026): off by default.
- `sandbox.mode`, `sandbox.networkAccess`, `sandbox.readBoundary` (`system` or `workspace`).
- The CLI rewrites this file and repairs missing fields. Some fields are CLI-managed.

Permission tokens (permissions page): `Shell(cmd)`, `Read(glob)`, `Write(glob)`, `WebFetch(domain)`, `Mcp(server:tool)`. Deny rules win over allow rules. Relative paths are scoped to the workspace.

Print mode and approvals. The docs conflict:
- Headless page: "Without `--force`, changes are only proposed, not applied."
- Using page: "Cursor has full write access in non-interactive mode."
- Permissions page: "Print mode can use write and shell tools. Use `permissions.allow`, `permissions.deny`, and `--force` to control what runs without prompts."

No page says what a print run does when it reaches an approval point without `--force`. A live test is needed.

Other print-mode rules:
- Untrusted workspace: a non-interactive run fails with guidance unless `--trust` or `--force` is given (January 2026 changelog).
- Admins can disable headless (non-interactive) use for the whole org (changelog v2026.06.09, Jun 9 2026).
- Team approval modes are respected in headless runs (March 2026 changelog).

Protocol approvals:
- Stream-json has no approval event.
- ACP has `session/request_permission`. See section 3.
- Print mode has no documented way to answer an approval. A cancel path is not documented either.

Sandbox:
- The run-modes page documents sandboxing on macOS (Seatbelt) and Linux (Landlock or bubblewrap). It has no Windows section. Windows sandboxing is not documented.
- `agent sandbox enable|disable|reset|run <cmd>`.
- Network access and read boundary are set in the config file or by `sandbox.json`.

Auto-review (run-modes page):
- Recommended default mode. It runs allowlisted calls and sends the rest to a classifier.
- The classifier runs on Cursor's backend (Gemini 3.5 Flash Lite, Haiku fallback, as stated on the page).
- Instructions for it go in `~/.cursor/permissions.json` or `<project>/.cursor/permissions.json`. Plain-English `allow_instructions` and `block_instructions`.

Hooks (hooks page):
- Files: `<project>/.cursor/hooks.json` and `~/.cursor/hooks.json`. Hooks are processes that talk JSON over stdio.
- Hooks that can allow, deny or ask: `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `preToolUse` (ask not enforced), `subagentStart` (ask treated as deny).
- Merge rule across sources: any `deny` wins over `ask`, and `ask` wins over `allow`.
- Failure: a crash, timeout or non-zero exit (other than 2) is allowed through unless the hook sets `failClosed: true`. Exit code 2 denies.
- The hooks page lists the Agent hooks as applying to Cmd+K and Agent Chat. It names the CLI only for `workspaceOpen`. Changelog entries mention hooks running in CLI sessions (v2026.10.15 and v2026.08.11). Whether `beforeShellExecution` fires in print mode is not documented.

Repo files that change what runs:
- `.cursor/cli.json` (allow rules).
- `.cursor/hooks.json` (can return `allow`).
- `.cursor/mcp.json`.
- `AGENTS.md`, `CLAUDE.md` and `.cursor/rules`.
- `.cursor/worktrees.json`, which runs only after the workspace is trusted.

## 6. Models and effort

Sources: parameters page, slash-commands page, configuration page, models page (`cursor.com/docs/models-and-pricing.md`), changelog.

- Flags and commands: `--model <model>`, `--list-models`, `agent models`, `/model` (interactive), `/fast`, `/max-mode` (interactive).
- `agent models`: lists models for the account. The output format is not documented.
- New installs default to Auto (changelog v2026.07.06, Jul 6 2026).
- Team model restrictions apply in the CLI (changelog v2026.08.26, Aug 26 2026).
- Effort is set through model slugs, not a flag. Examples on the models page: `gpt-5-high`, `gpt-5-high-fast`, `gpt-5-low-fast`, `gpt-5.2-high`, `gpt-5.3-codex-high`.
- Changelog v2026.05.14 (May 14 2026): "Fast or high-effort model slugs passed to `--model` keep their parameters in `-p` mode." Changelog v2026.08.11: `--model` keeps Max Mode variants.
- Changelog v2026.09.28 (Sep 28 2026): `--model` runs the exact model picked, even when its ID starts with another model's ID.
- Model families named on the models page (display names, not slugs): Claude (Sonnet 5.5, Opus 5.5, Opus 5, Haiku 5.5, Fable 5.1, and others), GPT-5.x (including Sol, Terra and Luna names), Composer 2.5, Grok 4.7, Gemini 3.x, Kimi K3, GLM 5.x, Muse.
- No thinking-budget or reasoning-effort flag is documented.

## 7. Auth

Sources: authentication page, ACP page, parameters page, changelog.

- Browser login: `agent login`. It opens the browser. `NO_OPEN_BROWSER=1 agent login` prints the URL instead.
- API key: `CURSOR_API_KEY` env var (recommended), or `--api-key <key>`. Keys come from the dashboard at cursor.com/dashboard/api.
- ACP auth: `authenticate` with `methodId: "cursor_login"`. Or pre-authenticate with `agent login`, `CURSOR_API_KEY`, or `CURSOR_AUTH_TOKEN` (`--auth-token`).
- Status: `agent status` or `agent whoami`, with `--format text|json`.
- Logout: `agent logout`. Also `/logout` (interactive).
- Credential store: macOS Keychain by default. `AGENT_CLI_CREDENTIAL_STORE=file` stores credentials in an owner-only file, unencrypted (changelog v2026.06.29, Jun 29 2026). Windows storage is not stated on these pages.
- Org policy: CLI login enforces MDM sign-in policy, including org, team, email and domain allowlists (changelog v2026.08.11).
- Team: `agent team switch` changes the team (changelog v2026.10.22). Switching teams ends running ACP sessions (see section 3).
- Account required: `agent login` needs a Cursor account. The docs describe no logged-out mode for the agent.

## 8. Usage and tokens

- The stream-json reference (current) lists no token-count fields. `result` has `duration_ms` and `duration_api_ms`. The page says `duration_api_ms` currently equals `duration_ms`.
- The February 2026 changelog says stream-json now has "per-turn input/output/cache token totals and a request_id". The current reference shows `request_id` only. Treat token totals as unverified until a live run.
- ACP `session/prompt` returns `stopReason` in the docs. No usage field is documented.
- `/usage` (interactive) shows plan meters, on-demand spend, plan name and reset date (changelog v2026.07.13, Jul 13 2026). It is not in the slash-commands reference table. No `agent` subcommand for usage is documented.
- `agent about --format json` and `agent status --format json` exist (changelog, Apr 2026). The docs do not say whether either includes usage.
- Hook payloads: `preCompact` gives `context_usage_percent`, `context_tokens` and `context_window_size`. These are observational, for context-window use only.
- Cost per run: no field in any documented output.

## 9. Other

- MCP: `agent mcp list`, `list-tools <id>`, `login <id>`, `enable <id>`, `disable <id>`. Config: `.cursor/mcp.json` (project) or `~/.cursor/mcp.json`. Permission token: `Mcp(server:tool)`. Team MCP is allowlisted in the dashboard. `--approve-mcps` approves all.
- Rules and instructions: the CLI reads `.cursor/rules` (`.mdc` files), and `AGENTS.md` and `CLAUDE.md` at the project root. Nested `AGENTS.md` files apply when the agent edits a file in that directory (changelog v2026.10.22).
- Images and files: put file paths in the prompt text. The agent reads them with its tools (headless page). No attachment flag is documented for print mode. The ACP example sends text only.
- Cancel: ACP `session/cancel` (notification, `sessionId`). Print mode: no cancel method is documented. Interactive: Ctrl+C. Headless runs wait for their subagents before exiting (changelog v2026.08.11).
- Cloud: there is no `--cloud` flag in the parameters table. In interactive mode, prefixing a message with `&` sends it to a Cloud Agent. Cloud Agents also have a REST API at `https://api.cursor.com/v1`. Endpoints include `/v1/agents`, `/v1/agents/{id}/runs`, and an SSE stream per run. Auth is Basic or Bearer with a user or service-account key (`cloud-agent/api/endpoints.md`). Cloud Agents do not use Run Modes (run-modes page).
- Self-hosted workers: `agent worker start|debug|controller` (parameters page). Not a thread transport.
- Other subcommands: `agent plugin marketplace add|list|update|remove` (changelog v2026.07.13), `agent bedrock`, `agent env`, `agent team switch`, `agent sandbox`, `agent about`, `agent worker`, `agent update`, `agent install-shell-integration`.

## Discrepancies and open questions

Each of these needs a live run with a logged-in account. I did not log in or send a prompt.

1. Print-mode approvals. Three pages disagree (section 5). No page says what happens at an approval without `--force`.
2. Permission reply names. The ACP page uses hyphens (`allow-once`). The ACP spec uses underscores (`allow_once`). The page's example returns `optionId: "allow-once"`. Confirm the real option ids from a live `session/request_permission`.
3. Token usage. The Feb 2026 changelog claims token totals in stream-json. The current reference does not show them.
4. `/usage` and `agent persist` are in the changelog but not in the reference pages.
5. ACP model and mode switching. Not documented for Cursor. `session/set_mode` is in the spec.
6. The `--help` text. No page quotes the literal output of `agent --help`. The parameters page is the closest. Its table is the source used here.
7. Hooks in print mode. Not documented.
8. Windows sandboxing. Not documented.
9. Stream-json `tool_call` shapes for tools other than read and write. The page says other tools use `tool_call.function`. The shapes are not shown.

## Implications for Sotto (for the team to decide)

- Protocol: ACP (`agent acp`) for threads. It gives a sessionId, session/load for resume, session/cancel, and session/request_permission so the user answers approvals (ADR-0004). It matches the Grok and Devin adapters. Blocking `cursor/ask_question` and `cursor/create_plan` must be answered, or the agent waits.
- Side calls (titles, branch names, drafts under ADR-0026): `agent -p --output-format json --mode=ask` is a candidate. Confirm first that it asks nothing and writes nothing.
- Do not pass `--force`, `--yolo` or `--approve-mcps` by default. Each answers approvals for the user. Do not write allow rules into `cli-config.json` for the user.
- Trust: a checked-in `.cursor/cli.json` can add allow rules, and a checked-in `hooks.json` can return `allow`. Gate project-level config behind workspace trust.
- Hosts (README privacy section, an ADR and README change before code): `cursor.com` (install and docs), `downloads.cursor.com` (package downloads), `api2.cursor.sh` (the endpoint named on the ACP page as an example; the CLI's default host is not documented on these pages), `api.cursor.com` (Cloud Agents, only if used), and the Cursor backend for model and Auto-review classifier calls.
- Account: a thread needs a Cursor login or a Cursor API key. Sotto would not hold that key in the one-key slot. Asking for a second key is a product decision (AGENTS.md).
- Windows: the installer wipes `%LOCALAPPDATA%\cursor-agent`. A Sotto install step must not reuse that folder. Spawn `agent.exe` by absolute path. The `.cmd` shim needs a shell.

## Appendix A: local check on this machine (2026-10-23)

The CLI is not installed here. I did not run `agent --version`, `agent --help` or `agent acp --help`, because the binary is not on PATH. I did not install anything, log in, or send a prompt. I did not open `cli-config.json` or any file that may hold credentials.

Output of the checks, trimmed to the relevant lines:

```
== where agent            (no output; where.exe exit code 1)
== where cursor-agent     (no output)
agent: not on PATH
cursor-agent: not on PATH
== %LOCALAPPDATA%\cursor-agent
Name          Length LastWriteTime
worker.lock        0 8/24/2026 2:17:28 PM
(no versions folder)
== %USERPROFILE%\.local\bin
.claude
claude-swap.exe
claude.exe
claudex.ps1
cswap.exe
glmclaude.cmd
muse.cmd
python3.11.exe
seekclaude.cmd
(no agent or cursor-agent)
== %USERPROFILE%\.cursor
agents, ai-tracking, browser-logs, extensions, plugins, projects, rules, skills-cursor
.gitignore, argv.json, cli-config.json, ide_state.json, mcp.json, statsig-cache.json (plus two statsig .tmp files)
worker.lock present, modified 2026-08-24 14:17
versions dir present: False
cli-config.json present: True (modified 2026-08-24 14:17; not opened)
Cursor editor exe present: False
```

Reading: `worker.lock` and `cli-config.json` share the timestamp 2026-08-24 14:17. That suggests the CLI ran here on that date and was later removed. I did not confirm this.

## Sources

Primary, read or downloaded 2026-10-23:

- https://cursor.com/docs/cli/overview.md
- https://cursor.com/docs/cli/installation.md
- https://cursor.com/docs/cli/using.md
- https://cursor.com/docs/cli/headless.md
- https://cursor.com/docs/cli/acp.md
- https://cursor.com/docs/cli/changelog.md (the CLI changelog; version headings from v2026.06.09, month headings for January to May 2026)
- https://cursor.com/docs/cli/reference/parameters.md
- https://cursor.com/docs/cli/reference/output-format.md
- https://cursor.com/docs/cli/reference/authentication.md
- https://cursor.com/docs/cli/reference/permissions.md
- https://cursor.com/docs/cli/reference/configuration.md
- https://cursor.com/docs/cli/reference/slash-commands.md
- https://cursor.com/docs/cli/shell-mode.md (not used in the findings)
- https://cursor.com/docs/agent/security/run-modes.md
- https://cursor.com/docs/hooks.md
- https://cursor.com/docs/mcp.md (only the config-path lines checked)
- https://cursor.com/docs/rules.md (only the AGENTS.md lines checked)
- https://cursor.com/docs/models-and-pricing.md
- https://cursor.com/docs/cloud-agent/api/endpoints.md
- https://cursor.com/docs/llms.txt (page index)
- https://cursor.com/install (bash script, Linux and macOS)
- https://cursor.com/install?win32=true (PowerShell script, Windows)
- https://cursor.com/changelog (fetched; client-rendered, no CLI entries in the text I could read)
- https://agentclientprotocol.com/protocol/schema (ACP spec; read in two parts)

Not used: no secondary sources. Sotto's own adapters were read only to compare permission handling: `src/main/agents/grokRequests.ts`, `src/main/agents/devinRequests.ts`.

## Appendix B: live checks against 2026.10.22-27dcf5f (2026-10-23)

The CLI was installed with Cursor's PowerShell installer and signed in with `agent login`. Every check ran `agent acp` in a scratch folder, through a throwaway probe outside the repo, on GPT-5.4 Nano. These facts replace the open questions above where they differ.

**Install layout on Windows.** `%LOCALAPPDATA%\cursor-agent` holds only `agent.cmd`, `agent.ps1` and their `cursor-agent` copies. The program is `versions\<version>\node.exe` running `versions\<version>\index.js`; the launchers pick the newest version folder and set `CURSOR_INVOKED_AS`. Spawning that `node.exe` directly needs no shell. `agent --version` prints `2026.10.22-27dcf5f`.

**Sign-in.** `agent login` with `NO_OPEN_BROWSER=1` prints a `https://cursor.com/loginDeepControl?...` page and finishes by itself once the user signs in there. `agent status --format json` answers `{"status":"authenticated","isAuthenticated":true,...}` or `"unauthenticated"`, with the account's name and no token. On Windows the sign-in is kept in `%APPDATA%\Cursor\auth.json`, outside the config folder.

**`initialize`** answers protocol 1, `loadSession: true`, `mcpCapabilities: {http: true, sse: true}`, `promptCapabilities: {image: true, audio: false, embeddedContext: false}`, `sessionCapabilities: {list: {}}`, and one auth method, `cursor_login`. No agent version is given; read it from `--version`.

**Models.** A client that sends `clientCapabilities._meta.parameterizedModelPicker: true` gets the parameterized picker: 46 base models (`default` is Auto), each with its own `configOptions`. Every option has a `category`: `thought_level` is the model's effort (named `effort`, `reasoning` or `reasoning_effort` depending on the model, with values such as none, minimal, low, medium, high, xhigh, max), and `model_config` holds `context` and `fast`. `cursor/list_available_models` returns every model with its options in one call. `session/set_config_option` with `configId: "model"` and a base model name changes the model, and with the effort option's own ID changes effort; an unknown value is refused with JSON-RPC `-32602`. Without the flag the menu is 46 fixed variants such as `gpt-5.5[context=272k,reasoning=medium,fast=false]`, and only those exact strings are accepted.

**Model choice is global and written to disk.** Changing the model or effort over ACP rewrites `cli-config.json` (`model`, `selectedModel`, `modelSelectionHistory`) and `acp-config.json` in the config folder, and every later session, ACP or interactive, starts on it. The first probe moved the user's own default from Auto to GPT-5.4 Nano; it was set back the same day. `CURSOR_CONFIG_DIR` moves the whole config folder: with it pointed at a scratch folder the sign-in still worked, the user's `cli-config.json` was not touched, user and global skills were still listed, and ACP sessions were written under `<config>/acp-sessions/<sessionId>/` (`meta.json`, `store.db`).

**Modes.** `session/new` answers `modes` (`agent`, `plan`, `ask`) and a `mode` config option. Both `session/set_mode` and `session/set_config_option` change it, and Cursor sends `current_mode_update`.

**Updates.** `session_info_update` carries a title Cursor writes on the first prompt. `agent_thought_chunk` streams reasoning and `agent_message_chunk` the reply. Tool calls arrive as ACP `tool_call` (`kind` `execute`, `edit`, `read`, `other`; `rawInput.command` for commands, `rawInput.path` and `locations` for files) and `tool_call_update` (`status` `in_progress` then `completed`; `rawOutput` with `exitCode`, `stdout`, `stderr` for commands, `content` for reads, and a `diff` content block for edits). Tool call IDs hold a newline. `available_commands_update` lists the user's, global and built-in skills. `session/prompt` answers `{stopReason: "end_turn"}` and nothing else: **no token usage or cost is reported**, live or in the bundle's ACP agent.

**Permissions.** A command not in the allowlist arrives as `session/request_permission` with `content` text such as "Not in allowlist: git status" and options `allow-once`, `allow-always` and `reject-once` (kinds `allow_once`, `allow_always`, `reject_once`). `reject-once` completes the tool call with no output and the turn goes on. **An edit inside the project folder is never asked about** in `allowlist` mode: the bundle's `shouldBlockWrite` allows it unless a path is denied, protected (`.cursor` files, `.cursorignore`) or outside the workspace. The client's `fs` capability is not used for writes, and no hook runs before a file edit, so a client cannot make such an edit ask. Web fetches and searches ask with the same three options. Launch flags set the approval mode for the process: `--force` (`unrestricted`), `--auto-review` (a classifier on Cursor's servers runs what it judges safe and asks about the rest), and neither (`allowlist`).

**Questions and plans.** `cursor/ask_question` reaches a client as `session/request_permission` whose options are the question's answers (kind `allow_once`) plus `__ask_question_skip__`. `cursor/create_plan` is a blocking request carrying `name`, `overview`, `plan` (Markdown) and `todos`, sent after an ACP `plan` update with the same steps; answering `cancelled` lets the turn go on, and the model may ask again in words.

**Sessions.** `session/load` replays the whole conversation as `user_message_chunk`, `agent_thought_chunk`, `agent_message_chunk`, `tool_call` and `tool_call_update`, one whole message per chunk, with tool call IDs `replay-<turn>-<n>`, and no timestamps or message IDs. `session/list` answers each session's ID, folder, title and `updatedAt`. The agent implements `unstable_listSessions` and `unstable_setSessionModel` and no fork or resume method.

**Ask mode for short text.** With `mode` set to `ask`, a prompt for a branch name was answered with the name alone and no tool call. It still made a session, saved in the config folder.
