# Browser tools without a native prompt

Windows, September 21, 2026, on top of `133ea38c`. Zach reported that a Claude Code thread found the browser tools, asked to open a page and was refused without ever showing him anything he could answer. This note records what was actually checked.

## What was wrong

Sotto reached the browser endpoint through `--mcp-config`, which the native CLI treats as untrusted, so every call raised a `can_use_tool` request. Sotto routed it to the thread as a permission card whose whole text is the tool name and its arguments (`claudeRequests.ts`): for a no-argument tool that reads `mcp__sotto_browser__browser_pages` and `{}`. It names neither the browser nor Tools. That prompt arrives before the answer ADR-0020 actually designed, which is the one in Tools against the real page and action.

Confirmed in the reporting thread itself: the same tool call was refused under the thread's original permission mode and succeeded after Zach changed the mode, with no other change.

## What changed

Each client is told that Sotto's own browser server needs no native prompt, scoped to that server and nothing else. Claude Code is launched with `--allowedTools` naming the tools the thread's endpoint exposes; the names are listed one by one because the CLI does not match a wildcard there. Codex takes `default_tools_approval_mode = "auto"` on the `sotto_browser` entry Sotto already writes for that thread. Grok is spawned with `--allow 'MCPTool(sotto_browser__*)'`. No global provider configuration is changed. Opening a page, navigating, clicking and typing still wait for the user's one-time answer in Tools.

## Checked

- `npm run typecheck`, `npm run lint`: passed.
- `tests/integration/browserProviders.test.ts`, `browserAgentServer.test.ts`, `browserAgentTools.test.ts`, `browserTools.test.ts`: 36 tests passed. The Claude case now asserts the allowance holds exactly the endpoint's own tool names; it previously asserted the opposite.
- Native discovery with `SOTTO_BROWSER_LIVE=1`, run twice: **Codex and Claude Code passed** — each launched with the new setting, connected to the local endpoint and requested `tools/list` with zero model turns and zero tool calls.
- Grok's `--allow <RULE>` and its `MCPTool(server__*)` form were read from the pinned 1.0.5 binary's own `--help`, which lists `--allow` as a global option ahead of the subcommand, matching where Sotto passes it.

## Unchecked

- **Grok was not verified live and its flag may be inert.** `~/.grok/bin/grok.exe` on this computer is 1.0.40; Sotto pins 1.0.5, so the probe cannot connect. It fails identically with the change reverted, so this is a pre-existing version mismatch rather than a regression, but it means nothing about Grok here is evidence. Grok also runs in leader mode, where `--allow` rules are reported upstream not to apply, so the rule may be accepted and ignored.
- That the prompt is actually gone is not proven for any client. Native discovery sends no model turn, and only a real turn against a paid client raises an approval. What is proven is that each client accepts the new setting and still reaches the endpoint.
- Codex's `default_tools_approval_mode` was accepted at `thread/start` without error; that it suppresses an approval was not observed.
- No packaged build, no macOS, no model-driven browser journey.
