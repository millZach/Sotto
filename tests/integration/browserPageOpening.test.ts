// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserService } from '../../src/main/tools/browser'
import { createBrowserAgentServer } from '../../src/main/tools/browserAgentTools'
import { FilesService } from '../../src/main/files/service'
import type { BrowserAgentServer } from '../../src/main/agents/browserAgentServer'
import type { BrowserTask } from '../../src/shared/browser'

// Pages are Electron views; everything between the MCP request and the page is real.
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    url = ''; destroyed = false
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    debugger = Object.assign(new EventEmitter(), { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async (method: string) => method === 'DOM.getNodeForLocation' ? { backendNodeId: 7 } : method === 'DOM.describeNode' ? { node: { backendNodeId: 7, nodeName: 'BUTTON', attributes: ['aria-label', 'Save'] } } : {}) })
    getBackgroundThrottling = vi.fn(() => true)
    setBackgroundThrottling = vi.fn()
    getURL() { return this.url }
    isDestroyed() { return this.destroyed }
    loadURL(url: string) { this.url = url; return Promise.resolve() }
    setWindowOpenHandler = vi.fn()
    close() { this.destroyed = true; this.emit('destroyed') }
  }
  class IsolatedSession extends EventEmitter {
    setPermissionRequestHandler = vi.fn(); setPermissionCheckHandler = vi.fn(); setDevicePermissionHandler = vi.fn()
    webRequest = { onBeforeRequest: vi.fn() }
    closeAllConnections = vi.fn().mockResolvedValue(undefined)
  }
  return { BaseWindow: vi.fn(), screen: { getAllDisplays: () => [] }, nativeImage: {}, WebContentsView: vi.fn(class { webContents = new Contents(); bounds = { x: 0, y: 0, width: 1280, height: 800 }; setBounds = vi.fn(); getBounds = () => this.bounds }), session: { fromPartition: () => new IsolatedSession() } }
})

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-page-opening-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory: directory }), copyPath: vi.fn(), reveal: vi.fn() })
  const service = new BrowserService({ files, getWindow: () => null, emit: vi.fn(), openExternal: vi.fn(), destination: async () => 'embedded' })
  cleanup.push(() => service.dispose())
  const server = createBrowserAgentServer(() => service)
  cleanup.push(() => server.close())
  return { service, server }
}

/** A provider's own tool call, over the thread's authenticated loopback endpoint. */
async function call(server: BrowserAgentServer, threadId: string, name: string, args: unknown): Promise<{ isError?: boolean; body: Record<string, unknown> }> {
  const endpoint = await server.mcpServer(threadId)
  const response = await fetch(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(endpoint.headers.map(header => [header.name, header.value])) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const result = (await response.json() as { result: { isError?: boolean; content: { type: string; text: string }[] } }).result
  return { ...(result.isError ? { isError: true } : {}), body: JSON.parse(result.content[0]!.text) as Record<string, unknown> }
}

async function pending(service: BrowserService, threadId: string): Promise<BrowserTask> {
  let found: BrowserTask | undefined
  await vi.waitFor(async () => {
    const tasks = await service.tasks({ threadId })
    found = tasks.ok ? tasks.value.find(task => task.pendingAction) : undefined
    expect(found).toBeDefined()
  })
  return found!
}

describe('a page-opening grant through the browser agent tools', () => {
  it('is given only in Tools, then lets that thread open and navigate pages while clicks still wait for the user', async () => {
    const { service, server } = await setup()
    const listing = await service.list({ threadId: 'thread-a' }); if (!listing.ok) throw new Error('No workspace')
    const workspaceId = listing.value.workspace.workspaceId

    // The tools offer no way to ask for, or answer with, a grant.
    expect((await call(server, 'thread-a', 'browser_open', { url: 'http://localhost:4555/', description: 'Check the app', forThread: true })).isError).toBe(true)

    const first = call(server, 'thread-a', 'browser_open', { url: 'http://localhost:4555/', description: 'Check the app' })
    const asked = await pending(service, 'thread-a')
    expect(asked.pendingAction?.action.type).toBe('navigate')
    const answered = await service.answerAction({ threadId: 'thread-a', workspaceId, pageId: asked.pageId, taskId: asked.id, actionId: asked.pendingAction!.id, allow: true, forThread: true })
    expect(answered.ok).toBe(true)
    expect((await first).body).toMatchObject({ approvalRequired: false })

    const second = await call(server, 'thread-a', 'browser_open', { url: 'http://localhost:4600/', description: 'Check settings' })
    expect(second.isError).not.toBe(true)
    expect(second.body).toMatchObject({ approvalRequired: false, task: { pendingAction: null } })
    const secondTask = second.body.task as BrowserTask
    const moved = await call(server, 'thread-a', 'browser_action', { pageId: secondTask.pageId, taskId: secondTask.id, action: { type: 'navigate', url: 'http://localhost:4600/profile' } })
    expect(moved.body).toMatchObject({ approvalRequired: false })

    const click = call(server, 'thread-a', 'browser_action', { pageId: secondTask.pageId, taskId: secondTask.id, action: { type: 'click', x: 10, y: 10 } })
    const clickAsk = await pending(service, 'thread-a')
    expect(clickAsk.pendingAction?.action.type).toBe('click')
    await service.answerAction({ threadId: 'thread-a', workspaceId, pageId: clickAsk.pageId, taskId: clickAsk.id, actionId: clickAsk.pendingAction!.id, allow: false })
    expect(JSON.stringify((await click).body)).toContain('declined')

    // Another thread still asks, and Stop makes this one ask again.
    const other = call(server, 'thread-b', 'browser_open', { url: 'http://localhost:4555/', description: 'Check the app' })
    const otherAsk = await pending(service, 'thread-b')
    const otherWorkspace = await service.list({ threadId: 'thread-b' }); if (!otherWorkspace.ok) throw new Error('No workspace')
    await service.answerAction({ threadId: 'thread-b', workspaceId: otherWorkspace.value.workspace.workspaceId, pageId: otherAsk.pageId, taskId: otherAsk.id, actionId: otherAsk.pendingAction!.id, allow: false })
    await other
    expect((await service.revokePageOpening({ threadId: 'thread-a', workspaceId })).ok).toBe(true)
    const again = call(server, 'thread-a', 'browser_open', { url: 'http://localhost:4700/', description: 'Check again' })
    const againAsk = await pending(service, 'thread-a')
    await service.answerAction({ threadId: 'thread-a', workspaceId, pageId: againAsk.pageId, taskId: againAsk.id, actionId: againAsk.pendingAction!.id, allow: false })
    expect((await again).body).toMatchObject({ approvalRequired: false })
  })
})
