// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { claudePending } from '../../../src/main/agents/claudeRequests'
import { grokPending } from '../../../src/main/agents/grokRequests'
import { pendingRequest } from '../../../src/main/agents/codexRequests'
import { BROWSER_MCP_SERVER } from '../../../src/main/agents/browserAgentServer'
import { browserToolDefinitions } from '../../../src/main/tools/browserAgentTools'

const ask = (tool: string, input: unknown) => claudePending({
  request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: tool, input },
} as never)

/**
 * A native tool carries no description in the frame it asks with, so the card for one of Sotto's own
 * browser tools used to be the tool's name and its arguments. Wherever an allowance does not take,
 * this card is what the user has to answer (ADR-0020).
 */
describe('the browser permission card says what a press does', () => {
  it('says something readable for every tool the endpoint exposes', () => {
    for (const tool of browserToolDefinitions) {
      const text = ask(`mcp__${BROWSER_MCP_SERVER}__${tool.name}`, {})!.request.text
      expect(text).toContain('Sotto’s browser')
      expect(text).toContain('still ask you in Tools')
      expect(text).not.toContain('mcp__')
      expect(text).not.toContain('{}')
    }
  })

  it('names the page it would open and repeats why the agent asked', () => {
    const text = ask(`mcp__${BROWSER_MCP_SERVER}__browser_open`, { url: 'http://localhost:5173/', description: 'Check the composer' })!.request.text
    expect(text).toContain('open http://localhost:5173/')
    expect(text).toContain('Check the composer')
  })

  it('names the action rather than the tool', () => {
    const said = (action: unknown): string => ask(`mcp__${BROWSER_MCP_SERVER}__browser_action`, { action })!.request.text
    expect(said({ type: 'navigate', url: 'http://localhost:5173/settings' })).toContain('go to http://localhost:5173/settings')
    expect(said({ type: 'click', x: 10, y: 20 })).toContain('click in the page')
    expect(said({ type: 'type', text: 'hello' })).toContain('type into the page')
    // The typed text is the user's to read in Tools, not something the card repeats back.
    expect(said({ type: 'type', text: 'hunter2' })).not.toContain('hunter2')
  })

  it('leaves a tool from another server with the name it came with', () => {
    const text = ask('mcp__other__do_something', { any: 'thing' })!.request.text
    expect(text).toContain('mcp__other__do_something')
  })

  it('still carries the raw arguments for the detail view', () => {
    const pending = ask(`mcp__${BROWSER_MCP_SERVER}__browser_open`, { url: 'http://localhost:5173/' })!
    expect(pending.request.context?.details).toContain('http://localhost:5173/')
  })
})

const grokAsk = (rawInput: unknown, title = 'use_tool'): string => grokPending('w1', 'session/request_permission', {
  sessionId: 's1', toolCall: { toolCallId: 't1', title, rawInput },
  options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
}, 'thread')!.request.text

/**
 * Grok reaches an MCP tool through its own use_tool, so the tool Sotto owns is in the arguments. The
 * shape is read from recorded session traffic rather than from a permission frame (issue #199), so a
 * shape that does not match has to keep the card Grok already gave.
 */
describe('a Grok permission for Sotto’s browser says the same thing', () => {
  it('reads the tool out of use_tool and its arguments out of tool_input', () => {
    const text = grokAsk({ tool_name: `${BROWSER_MCP_SERVER}__browser_open`, tool_input: { url: 'http://localhost:5173/' } })
    expect(text).toContain('open http://localhost:5173/')
    expect(text).toContain('still ask you in Tools')
    expect(text).not.toContain('use_tool')
  })

  it('names the action, not the meta-tool', () => {
    expect(grokAsk({ tool_name: `${BROWSER_MCP_SERVER}__browser_action`, tool_input: { action: { type: 'click', x: 1, y: 2 } } })).toContain('click in the page')
  })

  it('keeps Grok’s own card for another server and for a shape it does not recognise', () => {
    expect(grokAsk({ tool_name: 'linear__get_issue', tool_input: {} }, 'linear__get_issue')).toContain('linear__get_issue')
    expect(grokAsk({ unexpected: true }, 'something else')).toContain('something else')
  })
})

const codexAsk = (params: Record<string, unknown>): string =>
  pendingRequest('c1', 'mcpServer/elicitation/request', { threadId: 'n1', ...params }, 'thread')!.request.text

describe('a Codex elicitation about Sotto’s browser says which browser', () => {
  it('names the tool when the body carries one', () => {
    expect(codexAsk({ serverName: BROWSER_MCP_SERVER, request: { name: 'browser_open', arguments: { url: 'http://localhost:5173/' } } })).toContain('open http://localhost:5173/')
  })

  // The body's shape is not established against a real client, so the server alone still has to read.
  it('names the browser when the body cannot be read', () => {
    const text = codexAsk({ serverName: BROWSER_MCP_SERVER, message: 'Approve app tool call?' })
    expect(text).toContain('Sotto’s browser')
    expect(text).toContain('Approve app tool call?')
    expect(text).toContain('still ask you in Tools')
  })

  it('leaves another server’s elicitation alone', () => {
    expect(codexAsk({ serverName: 'linear', message: 'Pick an issue' })).toBe('Pick an issue')
  })
})
