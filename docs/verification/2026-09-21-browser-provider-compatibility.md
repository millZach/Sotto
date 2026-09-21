# Shared browser provider compatibility

Verified on Windows, September 21, 2026. This note covers native tool discovery and thread admission, not rendered browser behavior or paid end-to-end page testing.

## Verified

- Codex: the installed 0.155.1 generated schemas expose `dynamicTools` on `thread/start`, but not on `thread/resume`. Sotto therefore injects `config.mcp_servers.sotto_browser` separately on each thread start/resume. A real native App Server connected to the local MCP endpoint and requested `tools/list` without a model turn.
- Claude Code: the per-thread `--mcp-config` JSON config reached the local MCP endpoint and requested `tools/list` without a model turn. Existing native permission flags remain unchanged. Browser tool calls use a six-minute timeout so the user can answer in Tools.
- Grok 1.0.5: native ACP initialization advertised `mcpCapabilities.http: true`; `session/new` with a supplied HTTP MCP endpoint requested `tools/list` without a model turn. Session loads carry the same thread-scoped integration. The documented default MCP tool timeout is 6,000 seconds.
- Scripted real-child adapter tests cover fresh thread injection and reconnect with renewed admission credentials for these three providers. `SottoThreadHost` maps the adapter's own identifier to the Sotto thread ID before admitting a client.
- Transport tests exercise separate thread credentials, forged thread arguments, browser-origin rejection, exact Host validation, absent and revoked credentials, bounded request bodies, unknown tools and safe error output. No native permission is auto-allowed by this integration.

Run the deterministic checks with:

```sh
npx vitest run tests/unit/main/browserAgentServer.test.ts tests/integration/browserProviders.test.ts tests/unit/main/devinPolicy.test.ts --maxWorkers=2
```

All 24 tests passed. Native discovery is opt-in through `SOTTO_BROWSER_LIVE=1` and `tests/integration/browserProvidersLive.test.ts`. The three supported native clients passed discovery with zero model turns. The probe records only protocol method names and never prints a credential, prompt, page, or native protocol body.

## Devin compatibility gap

The installed Devin 3000.10.31 advertises neither HTTP nor SSE MCP support through ACP. Supplying a valid stdio MCP relay in `session/new.mcpServers` was accepted but produced zero MCP requests during initialization. One bounded synthetic model turn asking only for the synthetic browser probe also produced zero MCP requests. No browser action or unrelated permission was approved, and testing stopped after that turn.

The installed CLI exposes no dedicated per-process MCP config flag. Its documented `--config` overrides the main user configuration, while entries under its old `mcpServers` key are automatically migrated to dedicated MCP config files. Sotto has not established a safe thread-scoped override that preserves account configuration and ADR-0017. The inert injection and unused relay were removed. A deterministic fixture asserts that Devin receives no browser credentials and retains empty ACP MCP server lists. Devin threads can still use the human-operated Tools browser; agent browser tools are not available there.

This is a native compatibility limitation, not a passing-fixture claim. Adding Devin support requires a verified per-session integration seam or a separately reviewed, isolated native configuration mechanism.

## References

- [Codex App Server](https://learn.chatgpt.com/docs/app-server) and [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Claude Code CLI flags](https://code.claude.com/docs/en/cli-reference)
- [ACP session setup and MCP capabilities](https://agentclientprotocol.com/protocol/v1/session-setup)
- [Grok MCP configuration and timeouts](https://docs.x.ai/build/features/mcp-servers)
- [Devin MCP configuration and migration](https://docs.devin.ai/cli/extensibility/mcp/configuration) and [CLI flags](https://docs.devin.ai/cli/reference/commands)
- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
