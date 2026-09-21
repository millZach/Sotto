// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserAgentServer, browserToolDefinitions } from '../../../src/main/tools/browserAgentTools'
import type { BrowserService } from '../../../src/main/tools/browser'
import type { BrowserTask } from '../../../src/shared/browser'
import type { BrowserToolResult } from '../../../src/main/agents/browserAgentServer'

const pageId = 'f6a804fd-77c9-497c-bc16-ce0d0a7b7a59'
const taskId = '506e4ebf-949e-4115-b206-80997241ef09'
const workspaceId = 'a'.repeat(64)
const workspace = { threadId: 'owner', projectId: 'project', workingDirectory: 'C:/work', workspaceId }
const task: BrowserTask = { id: taskId, threadId: 'owner', workspaceId, pageId, status: 'working', description: 'Check save', updatedAt: 1, steps: [], thumbnail: 'private-thumbnail', evidence: [{ id: 'capture', at: 1, url: 'http://localhost:4567/private', viewport: null, image: 'private-screenshot', width: 1280, height: 800 }], summary: null, unchecked: [], pendingAction: null, output: 'private-observation' }
const decode = (result: BrowserToolResult) => JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
const servers: ReturnType<typeof createBrowserAgentServer>[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })
function setup(shared = false) {
  const page = { id: pageId, workspace, url: 'http://localhost:4567/private', title: 'private-title', status: 'ready', error: null, canGoBack: false, canGoForward: false, sharedOrigin: shared ? 'http://localhost:4567' : null, viewport: null }
  const service = { list: vi.fn(async () => ({ ok: true, value: { workspace, pages: [page] } })), tasks: vi.fn(async () => ({ ok: true, value: [task] })), action: vi.fn(async () => ({ ok: true, value: { task, output: 'observed', image: 'data:image/png;base64,YQ==', approvalRequired: false } })), waitForAction: vi.fn(), agentOpen: vi.fn(), startTask: vi.fn(), finishTask: vi.fn() }
  const server = createBrowserAgentServer(() => service as unknown as BrowserService)
  servers.push(server)
  return { server, service, page }
}
describe('thread browser tool dispatcher', () => {
  it('exposes neither authority overrides nor arbitrary debugger commands', async () => {
    const { server, service } = setup(true)
    expect(browserToolDefinitions.map(tool => tool.name)).toEqual(['browser_pages', 'browser_open', 'browser_start', 'browser_action', 'browser_status', 'browser_finish'])
    for (const extra of [{ threadId: 'victim' }, { workspaceId: 'b'.repeat(64) }, { approved: true }, { command: 'Runtime.evaluate' }]) {
      expect((await server.call('owner', 'browser_action', { pageId, taskId, action: { type: 'inspect' }, ...extra })).isError).toBe(true)
    }
    expect(service.action).not.toHaveBeenCalled()
    expect(service.list).not.toHaveBeenCalled()
    expect((await server.call('owner', 'answerAction', { allow: true })).isError).toBe(true)
  })
  it('redacts user-owned page titles, URLs and observations before sharing and after a cross-origin change', async () => {
    const { server, page } = setup()
    expect(decode(await server.call('owner', 'browser_pages', {}))).toEqual({ pages: [{ pageId, shared: false }] })
    const result = JSON.stringify(decode(await server.call('owner', 'browser_status', {})))
    expect(result).not.toContain('private-')
    expect(result).not.toContain('localhost')
    page.sharedOrigin = 'http://localhost:9876'
    expect(JSON.stringify(decode(await server.call('owner', 'browser_status', {})))).not.toContain('private-')
    expect((await server.call('owner', 'browser_status', { taskId: '17a91424-938d-4214-b025-af7d254e1db2' })).isError).toBe(true)
  })
  it('binds calls to the transport thread and resolved workspace and sends screenshots as image content', async () => {
    const { server, service } = setup(true)
    const result = await server.call('owner', 'browser_action', { pageId, taskId, action: { type: 'screenshot' } })
    expect(service.list).toHaveBeenCalledWith({ threadId: 'owner' })
    expect(service.action).toHaveBeenCalledWith({ threadId: 'owner', workspaceId, pageId, taskId, action: { type: 'screenshot' } })
    expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'YQ==' })
    const body = JSON.stringify(decode(result))
    expect(body).not.toContain('private-thumbnail')
    expect(body).not.toContain('private-screenshot')
    expect(body).not.toContain('private-observation')
    expect(body).toContain('observed')
  })
  it('holds the same tool call until the user answers and checks sharing again before returning observations', async () => {
    const { server, service, page } = setup(true)
    const actionId = '17a91424-938d-4214-b025-af7d254e1db2'
    const pending = { ...task, pendingAction: { id: actionId, action: { type: 'click' as const, x: 20, y: 30 }, description: 'Click save', expiresAt: Date.now() + 1000 } }
    service.action.mockResolvedValueOnce({ ok: true, value: { task: pending, approvalRequired: true, output: '', image: '' } })
    let answer!: (value: BrowserTask) => void
    service.waitForAction.mockImplementationOnce(() => new Promise<BrowserTask>(resolve => { answer = resolve }))
    let finished = false
    const calling = server.call('owner', 'browser_action', { pageId, taskId, action: { type: 'click', x: 20, y: 30 } }).then(result => { finished = true; return result })
    await vi.waitFor(() => expect(service.waitForAction).toHaveBeenCalledWith(taskId, actionId))
    expect(finished).toBe(false)
    page.sharedOrigin = null
    answer({ ...task, status: 'paused' })
    const result = JSON.stringify(decode(await calling))
    expect(result).not.toContain('private-')
    expect(result).toContain('paused')
  })
  it('redacts finished tasks and status if an observation grant changes during the request', async () => {
    const { server, service, page } = setup(true)
    service.finishTask.mockImplementationOnce(async () => { page.sharedOrigin = null; return { ok: true, value: { ...task, status: 'completed' } } })
    const finish = await server.call('owner', 'browser_finish', { pageId, taskId, status: 'completed', summary: 'Stopped', unchecked: [] })
    expect(finish.isError).not.toBe(true)
    expect(JSON.stringify(decode(finish))).not.toContain('private-')
    page.sharedOrigin = 'http://localhost:4567'
    service.tasks.mockImplementationOnce(async () => { page.sharedOrigin = null; return { ok: true, value: [task] } })
    expect(JSON.stringify(decode(await server.call('owner', 'browser_status', {})))).not.toContain('private-')
  })
  it('returns a recoverable error before browser initialization without leaking thrown details', async () => {
    const server = createBrowserAgentServer(() => undefined); servers.push(server)
    expect((await server.call('owner', 'browser_pages', {})).isError).toBe(true)
    const { server: ready, service } = setup()
    service.list.mockRejectedValueOnce(new Error('secret-token'))
    const result = await ready.call('owner', 'browser_pages', {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })
})
