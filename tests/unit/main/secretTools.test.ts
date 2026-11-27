// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecretToolServer, secretResult, secretToolDefinitions } from '../../../src/main/agents/secretTools'
import { DEVIN_SOTTO_SERVERS } from '../../../src/main/agents/devinPolicy'
import { REQUEST_SECRET_TOOL, RELEASE_SECRET_TOOL, SECRET_REQUESTS_MCP_SERVER } from '../../../src/shared/secretRequests'
import type { SecretOutcome } from '../../../src/main/secrets/secretRequests'

const servers: SecretToolServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })
function server(admits = true, outcome: SecretOutcome = { status: 'declined' }) {
  const service = { ask: vi.fn(async () => outcome), release: vi.fn(() => 2) }
  const tools = new SecretToolServer({ admits: () => admits, service })
  servers.push(tools)
  return { tools, service }
}
const parse = (result: { content: { type: string; text?: string }[] }) => JSON.parse(result.content[0]!.text!) as Record<string, unknown>

describe('sotto_secrets', () => {
  it('lists request_secret, loaded up front, and release_secret', () => {
    expect(secretToolDefinitions.map(tool => tool.name)).toEqual([REQUEST_SECRET_TOOL, RELEASE_SECRET_TOOL])
    expect(secretToolDefinitions[0]!._meta).toEqual({ 'anthropic/alwaysLoad': true })
    expect(secretToolDefinitions[0]!.description).toContain('never ask for such a value in chat')
    expect(DEVIN_SOTTO_SERVERS).toContain(SECRET_REQUESTS_MCP_SERVER)
  })

  it('answers a thread it does not admit with no server and refuses its calls', async () => {
    const { tools, service } = server(false)
    expect(await tools.mcpServer('thread-a')).toBeUndefined()
    const result = await tools.call('thread-a', REQUEST_SECRET_TOOL, { label: 'Key', reason: 'Why' })
    expect(result.isError).toBe(true)
    expect(service.ask).not.toHaveBeenCalled()
  })

  it('says what is wrong with a request and asks nothing', async () => {
    const { tools, service } = server()
    const result = await tools.call('thread-a', REQUEST_SECRET_TOOL, { label: 'Key', reason: 'Why', fields: [{ name: 'a', label: 'A' }, { name: 'A', label: 'B' }] })
    expect(result.isError).toBe(true)
    expect(String(parse(result).message)).toContain('Give each field its own name.')
    expect((await tools.call('thread-a', REQUEST_SECRET_TOOL, { label: 'Key', reason: 'Why', timeoutMs: 10 })).isError).toBe(true)
    expect((await tools.call('thread-a', REQUEST_SECRET_TOOL, { label: 'Key', reason: 'Why', fields: Array.from({ length: 9 }, (_, index) => ({ name: `f${index}`, label: 'F' })) })).isError).toBe(true)
    expect(service.ask).not.toHaveBeenCalled()
  })

  it('passes the call\'s signal and the client\'s wait on to the card', async () => {
    const { tools, service } = server()
    const controller = new AbortController()
    await tools.call('thread-a', REQUEST_SECRET_TOOL, { label: 'Key', reason: 'Why' }, { signal: controller.signal, waitMs: 30_000 })
    expect(service.ask).toHaveBeenCalledWith('thread-a', { label: 'Key', reason: 'Why' }, { signal: controller.signal, waitMs: 30_000 })
  })

  it('tells the agent not to ask in chat when a card ends without a value', async () => {
    for (const status of ['declined', 'cancelled', 'timed_out'] as const) {
      const { tools } = server(true, { status })
      const reply = parse(await tools.call('thread-a', REQUEST_SECRET_TOOL, { label: 'Key', reason: 'Why' }))
      expect(reply.status).toBe(status)
      expect(typeof reply.note).toBe('string')
    }
    expect(String(secretResult({ status: 'declined' }, false).note)).toContain('Don\'t ask for it in chat')
  })

  it('answers a saved card with references or files by name, and the one of each for a single value', () => {
    expect(secretResult({ status: 'saved', delivery: 'secretRef', refs: { value: 'secret-ref:a' } }, false)).toEqual({ status: 'saved', secretRef: 'secret-ref:a' })
    expect(secretResult({ status: 'saved', delivery: 'secretRef', refs: { user: 'secret-ref:a', password: 'secret-ref:b' } }, true)).toEqual({ status: 'saved', secretRefs: { user: 'secret-ref:a', password: 'secret-ref:b' } })
    expect(secretResult({ status: 'saved', delivery: 'file', files: { value: '/f' } }, false)).toMatchObject({ status: 'saved', file: '/f' })
    expect(secretResult({ status: 'saved', delivery: 'file', files: { a: '/a' } }, true)).toMatchObject({ status: 'saved', files: { a: '/a' } })
  })

  it('lets go of what the agent names', async () => {
    const { tools, service } = server()
    const reply = parse(await tools.call('thread-a', RELEASE_SECRET_TOOL, { secretRefs: [`secret-ref:${'a'.repeat(32)}`], files: ['/f'] }))
    expect(reply).toEqual({ released: 2 })
    expect(service.release).toHaveBeenCalledWith('thread-a', { secretRefs: [`secret-ref:${'a'.repeat(32)}`], files: ['/f'] })
    expect((await tools.call('thread-a', RELEASE_SECRET_TOOL, { secretRefs: ['not-a-ref'] })).isError).toBe(true)
  })
})
