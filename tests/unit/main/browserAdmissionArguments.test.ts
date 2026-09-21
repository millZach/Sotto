// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BROWSER_MCP_SERVER, browserCodexConfig, BrowserAgentServer } from '../../../src/main/agents/browserAgentServer'
import { grokArguments } from '../../../src/main/agents/grok'
import { browserToolDefinitions } from '../../../src/main/tools/browserAgentTools'

/**
 * The browser's own tools carry no native prompt (ADR-0020). Each client encodes that differently, and
 * the fixtures replace the client, so these are the only checks that notice a setting going missing.
 */
describe('browser admission carries no native prompt', () => {
  it('names Sotto\'s own server in Grok\'s allow rule and nothing else', () => {
    const args = grokArguments()
    expect(args).toContain('--allow')
    const rules = args.filter((_value, index) => args[index - 1] === '--allow')
    expect(rules).toEqual([`MCPTool(${BROWSER_MCP_SERVER}__*)`])
    // The rule is a global option, ahead of the subcommand, which is where the client reads it.
    expect(args.indexOf('--allow')).toBeLessThan(args.indexOf('agent'))
  })

  it('approves only Sotto\'s own server for Codex', async () => {
    const server = new BrowserAgentServer(browserToolDefinitions, async () => ({ content: [] }))
    try {
      const config = await browserCodexConfig(server, 'thread', 'high') as { config: { mcp_servers: Record<string, { default_tools_approval_mode?: string }> } }
      expect(Object.keys(config.config.mcp_servers)).toEqual([BROWSER_MCP_SERVER])
      expect(config.config.mcp_servers[BROWSER_MCP_SERVER]!.default_tools_approval_mode).toBe('auto')
    } finally { await server.close() }
  })

  it('leaves Codex untouched when a thread has no browser tools', async () => {
    expect(await browserCodexConfig(undefined, 'thread')).toEqual({})
  })
})
