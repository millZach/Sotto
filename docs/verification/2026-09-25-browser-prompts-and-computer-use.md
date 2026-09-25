# Which prompts reach the browser, and why Codex cannot use Computer Use

Windows 11, September 25, 2026, against `origin/main` at `02e9185a`. This is step 0 of `docs/plans/2026-09-25-agent-tool-exposure.md`. It replaces the "Unchecked" list of `2026-09-21-browser-tools-without-a-native-prompt.md` with results from real model turns. Clients: Claude Code 2.1.281, Codex 0.156.1 (npm), Grok 1.0.41.

## How it was checked

Two opt-in live tests, which cost paid model turns and never run in CI:

- `SOTTO_BROWSER_TURN_LIVE=1 npx vitest run tests/integration/browserProvidersLive.test.ts` runs one turn per case through Sotto's own adapter. A `BrowserAgentServer` exposes one tool named `browser_status`, and the agent is asked to call it once. The test records whether a native request reached the thread before the tool was called. Each request is denied.
- `SOTTO_CODEX_COMPUTER_USE_LIVE=1 npx vitest run tests/integration/codexComputerUseLive.test.ts` asks a Codex thread to list the open apps using Computer Use only. It records the native requests and how the Computer Use tool calls ended. Every request is denied. `SOTTO_CODEX_EXECUTABLE` runs a different Codex build.

Both report the request's kind, method or tool name and choice kinds, plus tool call status. The Computer Use test reports which known outcome a reply or tool result names (the sandbox stopped it, the native pipe was missing, native APIs were disabled, or no failure) rather than the text itself. Neither prints a prompt, an argument, a reply or a page. The early Computer Use runs quoted Codex's error messages, and those quotations are what this note reproduces.

## Does the client ask before Sotto's browser tool?

| Client | Mode | Result |
| --- | --- | --- |
| Claude Code | default (approval required) | Reached the tool, no native prompt |
| Claude Code | auto-accept edits | Reached the tool, no native prompt |
| Codex | default (auto-accept edits) | **Native prompt**: `mcpServer/elicitation/request`, tool not called |
| Codex | approval required | **Native prompt**: `mcpServer/elicitation/request`, tool not called |
| Grok | default (approval required) | **Native prompt**: a permission with Allow once and Deny, tool not called |
| Grok | auto | Reached the tool, no native prompt |

- **Claude:** `--allowedTools` works, and with a real tool name.
- **Codex:** `default_tools_approval_mode = "auto"` does not stop the prompt. With `"approve"` on the same `sotto_browser` entry, both Codex modes reached the tool with no prompt (two further turns, with the source changed only for the run and then restored). In Codex's `AppToolApproval`, `auto` seems to decide from the tool's own hints, so a tool without them still asks. `approve` never asks.
- **Grok:** the `--allow 'MCPTool(sotto_browser__*)'` rule has no effect in approval-required mode, as the September 21 note suspected of leader mode.

So "it asks every time" was the Codex and Grok native prompt, then Sotto's own question in Tools. On Claude it was Sotto's question alone.

### After step 2 (`fix/browser-tools-ask-once`)

Codex's entry carries `approve`, and the Grok adapter answers Grok's prompt for this thread's own `sotto_browser__…` tools with Grok's one-time allow (ADR-0020, September 25 amendment). The same six cases then all reached the tool with no native prompt: Claude 2.1.282, Codex 0.157.0 and Grok 1.0.41. Two Grok findings shaped the change:

- **No Grok setting does it.** With the adapter's answer switched off (`SOTTO_BROWSER_NO_ADMISSION=1`) and the model told to use the full name `sotto_browser__browser_status`, Grok still prompted with `--allow 'MCPTool(sotto_browser__*)'`, both as a leader (`agent --leader stdio`) and as a local agent (`agent --no-leader stdio`). Grok's prompt concerns its `use_tool` meta-tool (`variant: "UseTool"`), and the rule does not reach it.
- **The name the model uses varies.** Told to call "the browser_status tool from the sotto_browser MCP server", Grok passed the bare `browser_status`, which does not say which server it belongs to, so the adapter leaves that prompt for the user. Asked in ordinary words to check the browser, it found the tool through `search_tool` and used `sotto_browser__browser_status` in both runs, which the adapter answered. The probe now asks Grok that way.

## Codex and Computer Use

Two tool servers are involved, and the first runs went to the wrong one. `cua_repl`, from the `unified-computer-use` plugin, has only its browser surface on (`CUA_REPL_ENABLED_SURFACES=browser`). Native desktop control is the `computer-use` skill, which runs through `node_repl` (the `@oai/sky` service in the user's global `~/.codex/config.toml`) and a helper, `codex-computer-use.exe`, that serves a named pipe. Sotto loads both servers from the user's own Codex config. Asked only to "use Computer Use", the model picked `cua_repl`. Invoked with `$computer-use:computer-use`, it used `node_repl`.

| Run | Server | Tool calls | Codex's answer |
| --- | --- | --- | --- |
| Sotto, default mode | `cua_repl` | failed twice | "trusted Node process exited unexpectedly; kernel reset" |
| Sotto, default mode, parent environment passed through | `cua_repl` | failed twice | same |
| Sotto, Full access | `cua_repl` | completed | "Native computer APIs are disabled." |
| Sotto, Full access, the Codex desktop app's own `codex.exe` (0.155.0-alpha.16.3) | `cua_repl` | completed | "Native computer APIs are disabled." |
| Plain `codex exec` outside Sotto, the user's own config | `cua_repl` | one completed, two failed | Chrome is open; "no native apps in its app inventory" |
| Sotto, default mode, skill invoked, Codex app closed | `node_repl` | failed | "windows sandbox failed: helper_unknown_error: apply deny-read ACLs" |
| Sotto, Full access, skill invoked, Codex app closed | `node_repl` | two completed, one failed | "Computer Use native pipe is unavailable: failed to connect native pipe" |
| **Sotto, Full access, skill invoked, Codex app open** (Codex 0.157.0) | `node_repl` | **three completed** | **Listed the open apps: Sotto, Snagit Editor, ChatGPT, Google Chrome** |
| Sotto, default mode, skill invoked, Codex app open | `node_repl` | failed | "trusted Node process exited unexpectedly; kernel reset" |

Codex sent no approval request in any run. Every request would have been denied, and the only thing asked for was a list.

What this shows:

- **Codex's full Computer Use works from Sotto** when two things hold: the thread is in Full access, and the Codex desktop app is running. The app starts the helper that serves the native pipe (`codex-computer-use-swift` was running once the app was open, and no helper existed while it was closed).
- **Sotto's default sandbox stops it.** In `auto-accept-edits` (`on-request`, `workspace-write`), the Computer Use process dies, with or without the app. In Full access (`never`, `danger-full-access`) it runs.
- **The app is not the only way to start the helper.** The `@oai/sky` library that `node_repl` loads picks its transport in `targets/windows/internal/computer_use_client.js`. When `node_repl`'s environment has `SKY_CUA_NATIVE_PIPE=1`, which the Codex app writes into the global config, it connects to the app's helper (`codex-computer-use-swift.exe`, started by `ChatGPT.exe` from the `OpenAI.Codex` Store package) over the named pipe. Otherwise it starts its own `codex-computer-use.exe` as a child, with `--parent-pid`, so it exits with its run. Two plain `codex exec` turns with `-c 'mcp_servers.node_repl.env.SKY_CUA_NATIVE_PIPE="0"'` proved it. With the app open, a second helper started under `node.exe`, not the app, and listed the open apps. **With the app fully closed** (no `ChatGPT.exe`, no helper, no pipe), the helper again started under `node.exe` and listed Sotto, Snagit Editor, File Explorer and Google Chrome. It was gone once the turn ended. No service, scheduled task or startup entry starts either helper. The only Codex service is `CodexSandboxService`.
- **Not the cause:** Sotto's handling of elicitations and permission requests (none came), the environment allow-list (passing everything through changed nothing), or the Codex build (the desktop app's binary behaved like the npm one).
- **T3 Code does the same thing and no more.** Read at `pingdotgg/t3code@d06f0ff1`: it spawns its own `codex app-server` over stdio (`CodexSessionRuntime.ts:1334-1363`, `codexLaunchArgs.ts:3-14`), passes its whole environment (`ProviderInstanceEnvironment.ts:5-21`), and maps Full access to `never` / `danger-full-access` for the whole thread and turn (`CodexSessionRuntime.ts:541-546`, `:581-584`). It has no sandbox exemption for one server, no daemon or proxy connection, and no mention of the helper, its pipe or `CODEX_WINDOWS_REGISTERED_CORE`. Its Computer Use working comes from starting threads in Full access while the Codex app is open. T3's own provider logs on this machine (`~/.t3/userdata/logs/provider`, files dated September 13 and 19) record the same error 18 times, "Computer Use native pipe is unavailable: failed to connect native pipe: The system cannot find the file specified." So T3 needs the app open too. Only the error text and file dates were read, no conversation content.

### After step 4 (`fix/codex-computer-use-needs`)

Sotto now names Computer Use calls and explains the two known failures on the call's own step. Two live turns with `$computer-use:computer-use`, Codex 0.157.0, the Codex app closed:

| Run | Steps | What the step says |
| --- | --- | --- |
| Default mode | two `Computer Use` steps, both failed | "Computer Use can't run in this thread's sandbox. Nothing was changed. Switch the thread to Full access to use it." |
| Full access | one `Computer Use` step completed, one helper `node_repl / js` step (no `sky` use) completed, one `Computer Use` step failed | "Computer Use needs the Codex app open. Nothing was changed. Open Codex and ask again." |

## Unchecked

- Whether the self-started helper asks the same per-app questions as the app's helper ("Allow Codex to use <app>?"). Only listing was tried, and no question came from either.
- Whether the self-started path works from a Sotto thread. It was proven with plain `codex exec`, and Sotto's default sandbox kills Computer Use whichever helper it uses.
- A server named `sotto_browser` in Grok's own configuration would look the same to the adapter as Sotto's, so its tools would be admitted too. Whether Grok lets a configured server share the name of one Sotto supplies was not tried.
- `SKY_CUA_NATIVE_PIPE` is an internal switch in OpenAI's library, not a documented setting, so a Codex update may change it.
- Whether Codex's Computer Use can run under `workspace-write` with a narrower allowance than Full access.
- The real Sotto browser tools other than `browser_status`, and Sotto's own question in Tools. Neither was part of these turns.
- macOS.
