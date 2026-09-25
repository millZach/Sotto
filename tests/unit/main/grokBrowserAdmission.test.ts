// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { grokBrowserAdmission, grokPending } from '../../../src/main/agents/grokRequests'
import { BROWSER_MCP_SERVER } from '../../../src/main/agents/browserAgentServer'
import { browserToolDefinitions } from '../../../src/main/tools/browserAgentTools'

const tools = browserToolDefinitions.map(tool => tool.name)
const once = { optionId: 'once', name: 'Allow once', kind: 'allow_once' }
const always = { optionId: 'always', name: 'Always allow', kind: 'allow_always' }
const reject = { optionId: 'no', name: 'Deny', kind: 'reject_once' }
const ask = (rawInput: unknown, options: unknown[] = [once, always, reject]) => grokPending('w1', 'session/request_permission', {
  sessionId: 's1', toolCall: { toolCallId: 't1', title: 'use_tool', rawInput }, options,
}, 'thread')!

/**
 * Grok's prompt for this thread's own browser server admits the agent to Sotto's endpoint and nothing
 * more; page actions still wait in Tools (ADR-0020). Only that prompt is answered, and only once.
 */
describe('Grok\'s prompt for Sotto\'s own browser tools', () => {
  it('is answered with Grok\'s one-time allow, never its always-allow', () => {
    for (const tool of tools) {
      expect(grokBrowserAdmission(ask({ tool_name: `${BROWSER_MCP_SERVER}__${tool}`, tool_input: {} }), BROWSER_MCP_SERVER, tools))
        .toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    }
  })

  it('is left for the user when it names another server, even with a browser tool\'s name', () => {
    expect(grokBrowserAdmission(ask({ tool_name: 'other_server__browser_open', tool_input: {} }), BROWSER_MCP_SERVER, tools)).toBeUndefined()
    expect(grokBrowserAdmission(ask({ tool_name: `x${BROWSER_MCP_SERVER}__browser_open`, tool_input: {} }), BROWSER_MCP_SERVER, tools)).toBeUndefined()
  })

  it('is left for the user when the tool is not one this endpoint exposes', () => {
    expect(grokBrowserAdmission(ask({ tool_name: `${BROWSER_MCP_SERVER}__browser_delete_everything`, tool_input: {} }), BROWSER_MCP_SERVER, tools)).toBeUndefined()
    expect(grokBrowserAdmission(ask({ tool_name: `${BROWSER_MCP_SERVER}__browser_open` }), BROWSER_MCP_SERVER, [])).toBeUndefined()
  })

  it('is left for the user when Grok offers no one-time allow', () => {
    expect(grokBrowserAdmission(ask({ tool_name: `${BROWSER_MCP_SERVER}__browser_open` }, [always, reject]), BROWSER_MCP_SERVER, tools)).toBeUndefined()
  })

  it('leaves every other request alone', () => {
    expect(grokBrowserAdmission(ask({ command: 'rm -rf build' }), BROWSER_MCP_SERVER, tools)).toBeUndefined()
    expect(grokBrowserAdmission(ask(undefined), BROWSER_MCP_SERVER, tools)).toBeUndefined()
  })
})
