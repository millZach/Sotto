# DeepSeek Harness (`dsh`) ACP probe

Checked October 24, 2026 on the Apple silicon Mac against `@deepseek-ai/dsh` 0.2.1-rc.2 from npm (the same version
the installed desktop wrapper reports), driven by a throwaway hand-rolled ACP client in a disposable folder with an
isolated `DSH_HOME`. The master-branch sources of `packages/acp/acp`, `packages/bundle/base`,
`packages/bundle/acp-app` and `packages/interaction/user-approval` were read the same day; master already carries
0.2.1-rc.3 bundle versions, so wire facts below are the shipped binary's where the two could differ. Prompt runs used
the user's own Spark cluster (SGLang, OpenAI-compatible, `deepseek-v4.1-flash`, 1,048,576 context, no key) behind a
`--patch` overlay that declares it as a `dsh-llm-pi-ai` route — the composition shape a Sotto adapter would generate
from the own-model-servers record (ADR-0124). Only protocol shapes, counts and file existence were recorded.

## The permission question

The ACP server does not auto-approve. The approval service decides before any answerer: policy `ask` delegates to the
composed answerers and falls through to the fail-closed `unavailable` with none, and policy `never` resolves every ask
`rejected` (it means never *ask*, and auto-*rejects*). The ACP bridge is one answerer: for agents it owns, it drains
pending updates, sends `session/request_permission` offering exactly `allow-once` and `reject-once`, maps `cancelled`
to cancelled and anything unexpected to rejected, and never infers a durable grant. A throwing answerer fails the
question closed. The docs' "machine permission answerer" is the *client*: a scripted controller may answer by policy;
a Sotto adapter would hold the request for the user instead, as the Grok, Devin and Cursor adapters do.

Permissions are sandbox escalation, in Codex's shape. A preset bundles a sandbox mode (`read-only`,
`workspace-write`, `danger-full-access`) with an approval policy (`ask` or `never`). Work inside the sandbox boundary
never asks. A denied tool call may be retried by the model with `sandbox_permissions` and a `justification`, and that
retry is what asks. The shipped ACP profile composes `workspace-write` + `ask` unless `DSH_PERMISSION_MODE` overrides
it process-wide. Live, on the cluster model:

- Read-only: a bash write was denied, the model retried with escalation, one request arrived, allow-once landed the
  file; the same flow with reject-once left no file and the turn still ended. A filesystem `write` behaved the same.
- Workspace-write: writes, bash and network (`curl https://example.com`) in the workspace ran with zero requests; a
  write into the home folder was denied, escalated, asked once, and landed on allow. `/tmp` is writable inside the
  boundary on macOS.
- Danger-full-access: a home-folder write landed with zero requests.
- Disconnecting with a request unanswered ended the process and the escalated write never landed.

A request carries only `toolCall: { toolCallId }`. The detail a request card needs — tool name, `command` or
`file_path`/`content`, `sandbox_permissions`, `justification` — is in the `tool_call` update the bridge drains first,
so an adapter joins by ID and shows the model's own justification beside the real arguments. Every tool kind arrives
as `other` with no locations or diff content, so activity rendering derives from the tool name and raw input.

Mode mapping this supports, each a per-process spawn (mode and sandbox root are process-level: the environment, and
`process.cwd()` at composition): **Ask for approval** as read-only + ask (every write asks, at the cost of a denied
first attempt and a model retry per write, which also depends on the model escalating — the cluster model did,
including uncoached once, but uncoached reliability is unmeasured); **Auto-accept edits** as workspace-write + ask,
with the menu saying commands and network inside the sandbox are also unasked, the way Cursor's gap is said plainly
(ADR-0128); **Full access** as danger-full-access; **Automatic** not offered. A mode change starts a fresh process
and resumes the session, as Cursor's do.

## The rest of the surface, live

- `initialize` answered protocol 1 in 0.7–1.6 s: `agentInfo` is `deepseek-harness-acp` version `0.0.1` (hardcoded;
  a version floor must read the CLI's `--version`, here 0.2.1-rc.2), `mcpCapabilities: { http: true }`,
  `promptCapabilities: { image: false, audio: false, embeddedContext: false }`,
  `sessionCapabilities: { close, list, resume }`, no `loadSession`, `authMethods: []`.
- `session/new` returns grouped `configOptions`: `model` whose value encodes the route pair
  (`["spark","deepseek-v4.1-flash"]`) under a provider group, and `reasoning_effort`
  (`off`, `low`, `high`, `max`; default `high`) when the model declares efforts — a hand-declared cluster model
  without efforts gets no selector. `session/set_config_option` returned the full state; a bogus effort was refused
  `-32602`. No modes, no commands.
- `session/close` then `session/resume` worked in one process and across a process restart, with no replayed updates
  (Sotto's event store already owns history). `session/list` lists persisted inactive sessions only, by `sessionId`
  and `cwd`. `session/load` is `-32601`. Fork and deletion are unsupported.
- `session/cancel` settled the prompt `cancelled` about 5 ms after the notification, killed the running `sleep`
  (no orphan), and the session took a later prompt. One prompt at a time per session; no steering.
- Replies arrive as committed messages and thoughts, not token deltas. `usage_update` carries `used` and `size`
  only — no input/output split and no cost; Usage would leave it out, as with Cursor.
- A Streamable HTTP MCP stub passed in `session/new` was mounted with its `Authorization` header, discovered, and
  called as `mcp__probe_tools__probe_echo` with no permission request. Startup failure of any one server rolls back
  the whole session (`failOnStartupError`), stdio commands must be absolute, and server names normalize to 32
  characters. Sotto's tool servers fit, behind a preflight.
- A direct instruction to use a question tool produced only a text reply; elicitation is outside this surface, so
  questions would be prose. Images were not advertised on either route tried.

## What remains open

DeepSeek cloud sign-in under an isolated Sotto `DSH_HOME` (the account platform's desktop path is gated to the
`desktop` profile), side writing without a tool-less generation route (start with none, as Muse did), Watcher's
instruction channel (inline, as on Muse and Cursor, is the known shape), Windows behaviour (bash-sandbox is disabled
there; a PowerShell sandbox stands in), first-run cold start on a clean machine, and how the explicit
compatibility-breaking-changes stance of the 0.1–0.2 line should set the client floor and update policy.
