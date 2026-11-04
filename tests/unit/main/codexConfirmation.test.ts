// @vitest-environment node
// Issue #2149: Codex's own approvals, and an MCP server's go-ahead such as Computer Use's app access, arrive as a form with
// nothing to fill in. The shape is Codex 0.166.0's (`McpServerElicitationRequestParams`, and `requestedSchema:
// { type: 'object', properties: {} }` from `build_mcp_tool_approval_elicitation_request`); the real Computer Use request
// has not been captured on a Mac or the Windows PC, so its server name and `_meta` here are assumptions.
import { describe, expect, it } from 'vitest'
import { answerRequest, pendingRequest } from '../../../src/main/agents/codexRequests'
import { BROWSER_MCP_SERVER } from '../../../src/main/agents/browserAgentServer'

const MESSAGE = 'Allow Computer Use to use "Sotto"?'
const ask = (params: Record<string, unknown> = {}) => pendingRequest(7, 'mcpServer/elicitation/request', { threadId: 'native-thread', turnId: 'turn-1',
  serverName: 'node_repl', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'js' }, message: MESSAGE,
  requestedSchema: { type: 'object', properties: {} }, ...params }, 'thread')!

describe('a Codex form with nothing to fill in is a confirmation (#2149)', () => {
  it('asks Allow once or Deny, with no text box, no options and no Skip', () => {
    const { request } = ask()
    expect(request).toMatchObject({ kind: 'permission', confirmation: true, options: [],
      permissionChoices: [{ id: 'accept', label: 'Allow once', kind: 'allow-once' }, { id: 'decline', label: 'Deny', kind: 'deny' }] })
    expect(request.questions).toBeUndefined()
    expect(request.skippable).toBeUndefined()
  })

  it('says what Codex is about to use on its first line and Codex’s own words on the second', () => {
    expect(ask().request.text).toBe(`Codex is asking before it uses Computer Use.\n${MESSAGE}`)
    expect(ask({ serverName: 'codex_apps', message: 'Allow this app to run tool "send"?' }).request.text)
      .toBe('Codex is asking before it uses an app.\nAllow this app to run tool "send"?')
    expect(ask({ serverName: 'linear', message: undefined, description: 'Allow the linear MCP server to run tool "list"?' }).request.text)
      .toBe('Codex is asking before it uses linear.\nAllow the linear MCP server to run tool "list"?')
    expect(ask({ serverName: undefined }).request.text).toBe(MESSAGE)
  })

  it('takes OpenAI’s two form spellings with no schema at all', () => {
    for (const mode of ['openai/form', 'openaiForm']) {
      expect(ask({ mode, requestedSchema: null }).request).toMatchObject({ kind: 'permission', confirmation: true })
      expect(ask({ mode, requestedSchema: undefined }).request).toMatchObject({ kind: 'permission', confirmation: true })
    }
  })

  it('sends accept with empty content for Allow once and decline for Deny, by choice or by an explicit answer', () => {
    expect(answerRequest(ask(), '', true, undefined, 'accept')).toEqual({ action: 'accept', content: {} })
    expect(answerRequest(ask(), '', false, undefined, 'decline')).toEqual({ action: 'decline', content: null })
    expect(answerRequest(ask(), '', true)).toEqual({ action: 'accept', content: {} })
    expect(answerRequest(ask(), '', false)).toEqual({ action: 'decline', content: null })
    // A choice whose approval does not match it grants nothing.
    expect(() => answerRequest(ask(), '', false, undefined, 'accept')).toThrow()
  })

  it('never reads consent from words: plain text and {} are refused', () => {
    for (const text of ['yes', 'y', 'allow', 'ok', 'sure', 'no', '{}', '{"allow":"yes"}']) {
      expect(() => answerRequest(ask(), text)).toThrow('Choose Allow once or Deny.')
    }
  })

  it('names Sotto’s browser for a confirmation about it, and the tool when Codex names one', () => {
    const named = ask({ serverName: BROWSER_MCP_SERVER, _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'browser_open', tool_params: { url: 'http://localhost:5173/' } } })
    expect(named.request).toMatchObject({ kind: 'permission', confirmation: true })
    expect(named.request.text).toContain('open http://localhost:5173/')
    const unnamed = ask({ serverName: BROWSER_MCP_SERVER, _meta: { codex_approval_kind: 'mcp_tool_call' }, message: 'Allow the sotto_browser MCP server to run tool "browser_open"?' })
    expect(unnamed.request.text.split('\n')[0]).toBe('Codex is asking before it uses Sotto’s browser.')
    expect(unnamed.request.text).toContain('unless this thread uses the browser without asking')
  })

  it('keeps a sign-in Codex takes through its own broker out of it: answered in Codex, or skipped to decline', () => {
    const signIn = ask({ serverName: 'codex_apps', _meta: { codex_approval_kind: 'browser_auth', fields: [{ name: 'password' }] }, message: 'Sign in to example.com' })
    expect(signIn.request.kind).toBe('question')
    expect(signIn.request.confirmation).toBeUndefined()
    expect(signIn.request.permissionChoices).toBeUndefined()
    expect(signIn.request.skippable).toBe(true)
    expect(signIn.request.questions).toMatchObject([{ required: true, options: [], allowFreeText: false, unavailableReason: expect.stringMatching(/Codex/u) }])
    for (const text of ['yes', '{}']) expect(() => answerRequest(signIn, text)).toThrow(/Codex/u)
    expect(answerRequest(signIn, '', undefined, undefined, undefined, true)).toEqual({ action: 'decline', content: null })
    expect(answerRequest(signIn, '', false)).toEqual({ action: 'decline', content: null })
  })

  it('leaves a form with fields a form', () => {
    const { request } = ask({ requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } })
    expect(request.kind).toBe('question')
    expect(request.confirmation).toBeUndefined()
  })
})
