// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { claudePending } from '../../../src/main/agents/claudeRequests'
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
