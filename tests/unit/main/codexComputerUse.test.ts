// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CodexActivityProjection, codexItemSchema, computerUseNeeds } from '../../../src/main/agents/codexActivity'
import { answerRequest, pendingRequest } from '../../../src/main/agents/codexRequests'
import type { AgentThread } from '../../../src/shared/agents'

const thread = (): AgentThread => ({ id: 'thread', projectId: 'project', title: 'Fixture', modelId: 'fixture', status: 'running', requests: [], messages: [] })
const context = { turnId: 'turn-1', phase: 'completed' as const }
const call = (server: string, code: string, extra: Record<string, unknown> = {}) =>
  codexItemSchema.parse({ id: `${server}-call`, type: 'mcpToolCall', server, tool: 'js', status: 'completed', arguments: { code }, ...extra })
const project = (item: ReturnType<typeof call>, runtimeMode?: AgentThread['runtimeMode']) => { const t = { ...thread(), ...(runtimeMode ? { runtimeMode } : {}) }; new CodexActivityProjection(() => 2_000).item(t, item, context); return t.activities![0]! }

/** Codex's Computer Use, as the live runs saw it (docs/verification/2026-09-25-browser-prompts-and-computer-use.md). */
describe('Codex Computer Use calls', () => {
  it('are named Computer Use, without keeping the code they ran', () => {
    const item = call('node_repl', 'const { sky } = await import("@oai/sky"); globalThis.sky = sky')
    expect(item).toMatchObject({ computerUse: true })
    expect(item).not.toHaveProperty('arguments')
    expect(project(item).title).toBe('Computer Use')
    expect(project(call('node_repl', 'await sky.list_apps()')).title).toBe('Computer Use')
    expect(project(call('cua_repl', 'anything')).title).toBe('Computer Use')
  })

  it('leave other JavaScript tool calls as they were', () => {
    const item = call('node_repl', 'console.log(skyline.length, weather.sky.colour, "./sky.js")')
    expect(item).not.toHaveProperty('computerUse')
    expect(project(item).title).toBe('node_repl / js')
  })

  it('say what to do when the sandbox or a closed Codex app stopped them', () => {
    const failed = (text: string) => project(call('node_repl', 'await sky.list_apps()', { status: 'failed', result: { content: [{ type: 'text', text }] } }))
    expect(failed('node_repl kernel exited unexpectedly: windows sandbox failed: helper_unknown_error: apply deny-read ACLs').error).toMatch(/sandbox.*Full access/su)
    expect(failed('trusted Node process exited unexpectedly; kernel reset, rerun your request').error).toMatch(/Full access/u)
    expect(failed('Computer Use native pipe is unavailable: failed to connect native pipe: The system cannot find the file specified. (os error 2)').error).toMatch(/Codex app open/u)
    expect(project(call('node_repl', 'await sky.click()', { status: 'failed', error: { message: 'Window not found' } })).error).toBe('Window not found')
  })

  it('keep Codex\'s own words under Sotto\'s, and do not blame the sandbox in Full access', () => {
    const crashed = call('node_repl', 'await sky.list_apps()', { status: 'failed', error: { message: 'trusted Node process exited unexpectedly; kernel reset, rerun your request' } })
    expect(project(crashed).error).toBe("Computer Use cannot run in this thread's sandbox. Nothing was changed. Switch the thread to Full access to use it.\ntrusted Node process exited unexpectedly; kernel reset, rerun your request")
    expect(project(crashed, 'full-access').error).toBe('trusted Node process exited unexpectedly; kernel reset, rerun your request')
    const denied = call('node_repl', 'await sky.list_apps()', { status: 'failed', error: { message: 'windows sandbox failed: helper_unknown_error: apply deny-read ACLs' } })
    expect(project(denied, 'full-access').error).toMatch(/^Computer Use cannot run in this thread's sandbox/u)
  })

  it('are only explained when the text is one Sotto recognises', () => {
    expect(computerUseNeeds('Window not found', true)).toBeUndefined()
    expect(computerUseNeeds(undefined, true)).toBeUndefined()
  })
})

describe('Codex requests Sotto used to refuse', () => {
  it('relays a link to open, and answers Continue and Decline', () => {
    const pending = pendingRequest('url', 'mcpServer/elicitation/request', { threadId: 't', serverName: 'apps', mode: 'url', message: 'Sign in to continue.', url: 'https://example.test/sign-in', elicitationId: 'e1' }, 't')!
    expect(pending.request.text).toBe('Sign in to continue.\nhttps://example.test/sign-in')
    expect(pending.request.options.map(option => option.id)).toEqual(['continue', 'decline'])
    expect(answerRequest(pending, 'continue')).toEqual({ action: 'accept', content: null })
    expect(answerRequest(pending, 'decline')).toEqual({ action: 'decline', content: null })
    expect(answerRequest(pending, 'continue', false)).toEqual({ action: 'decline', content: null })
  })

  it('answers OpenAI\'s own form like any other form', () => {
    for (const mode of ['openai/form', 'openaiForm']) {
      const pending = pendingRequest(mode, 'mcpServer/elicitation/request', { threadId: 't', serverName: 'apps', mode, message: 'Allow Codex to use Notepad?',
        requestedSchema: { type: 'object', properties: { decision: { type: 'string', enum: ['allow', 'deny'] } }, required: ['decision'] } }, 't')!
      expect(pending.request.options.map(option => option.id)).toEqual(['allow', 'deny'])
      expect(answerRequest(pending, 'allow')).toEqual({ action: 'accept', content: { decision: 'allow' } })
    }
  })

  it('still sends a form it cannot read back to Codex', () => {
    const pending = pendingRequest('odd', 'mcpServer/elicitation/request', { threadId: 't', mode: 'openai/form', message: 'Pick', requestedSchema: { type: 'array' } }, 't')!
    expect(() => answerRequest(pending, 'x')).toThrow(/directly in Codex/u)
  })
})
