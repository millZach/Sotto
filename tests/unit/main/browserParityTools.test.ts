// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserAgentServer, type BrowserAgentTools } from '../../../src/main/agents/browserAgentServer'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import type { ProviderHost } from '../../../src/main/agents/host'
import { browserToolDefinitions, createBrowserAgentServer, createHostBrowserAgentServer, hostBrowserToolDefinitions, hostParityBrowserToolDefinitions, parityBrowserToolDefinitions, type BrowserAgentService } from '../../../src/main/tools/browserAgentTools'
import { alwaysAsks, grantCovers } from '../../../src/main/tools/browserGrants'
import type { BrowserService } from '../../../src/main/tools/browser'
import { browserActionSchema, browserParityOpenInputSchema, browserStableActionSchema, BROWSER_DEVICE_PRESETS, PARITY_ONLY_ACTIONS, parityOpenUrl, presetSize, type BrowserTask } from '../../../src/shared/browser'
import { SOTTO_BROWSER_TOOLS } from '../../../src/shared/sottoBrowserTools'

const pageId = 'f6a804fd-77c9-497c-bc16-ce0d0a7b7a59'
const taskId = '506e4ebf-949e-4115-b206-80997241ef09'
const workspaceId = 'a'.repeat(64)
const workspace = { threadId: 'owner', projectId: 'project', workingDirectory: 'C:/work', workspaceId }
const task: BrowserTask = { id: taskId, threadId: 'owner', workspaceId, pageId, status: 'working', description: 'Check', updatedAt: 1, steps: [], thumbnail: null, summary: null, unchecked: [], pendingAction: null, output: null }
const servers: { close(): Promise<void> }[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })
const decode = (result: { content: unknown[] }) => JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>

function service() {
  const page = { id: pageId, workspace, url: 'http://localhost:5173/', title: 'Bench', status: 'ready', error: null, canGoBack: false, canGoForward: false, sharedOrigin: 'http://localhost:5173', viewport: null }
  return {
    list: vi.fn(async () => ({ ok: true, value: { workspace, pages: [page] } })), tasks: vi.fn(async () => ({ ok: true, value: [task] })),
    action: vi.fn(async () => ({ ok: true, value: { task, output: 'hovered', approvalRequired: false } })), waitForAction: vi.fn(), agentOpen: vi.fn(), startTask: vi.fn(), finishTask: vi.fn(),
    agentClose: vi.fn(async () => ({ ok: true, value: { closed: pageId } })), localServers: vi.fn(async () => ({ ok: true, value: [{ port: 5173, url: 'http://localhost:5173/', title: 'Vite', process: 'node' }] })),
  }
}

describe('the full browser catalog (ADR-0220)', () => {
  it('keeps the stable catalog as it was and adds close and servers beside it', () => {
    expect(browserToolDefinitions.map(tool => tool.name)).toEqual(['browser_pages', 'browser_open', 'iphone_open', 'browser_start', 'browser_action', 'browser_status', 'browser_finish', 'iphone_cloud_open', 'iphone_cloud_action', 'iphone_cloud_status', 'iphone_cloud_finish'])
    expect(parityBrowserToolDefinitions.map(tool => tool.name)).toEqual([...browserToolDefinitions.map(tool => tool.name), 'browser_close', 'browser_servers'])
    expect(hostParityBrowserToolDefinitions.map(tool => tool.name)).toEqual([...hostBrowserToolDefinitions.map(tool => tool.name), 'browser_close'])
    for (const name of ['browser_close', 'browser_servers']) expect(SOTTO_BROWSER_TOOLS).toContain(name)
    // The stable description never names an action only the full catalog has.
    const stableAction = browserToolDefinitions.find(tool => tool.name === 'browser_action')!
    for (const action of ['evaluate', 'record_start', 'wait_for', 'upload']) expect(stableAction.description).not.toContain(action)
    const parityAction = parityBrowserToolDefinitions.find(tool => tool.name === 'browser_action')!
    for (const action of ['snapshot', 'evaluate', 'record_start', 'wait_for', 'upload', 'dialog', 'appearance']) expect(parityAction.description).toContain(action)
  })

  it('takes a full-catalog action only with the full catalog on', async () => {
    const stable = service(); const parity = service()
    const stableServer = createBrowserAgentServer(() => stable as unknown as BrowserService); servers.push(stableServer)
    const parityServer = createBrowserAgentServer(() => parity as unknown as BrowserService, undefined, true); servers.push(parityServer)
    const hover = { pageId, taskId, action: { type: 'hover', selector: '#menu' } }
    expect((await stableServer.call('owner', 'browser_action', hover)).isError).toBe(true)
    expect(stable.action).not.toHaveBeenCalled()
    expect((await parityServer.call('owner', 'browser_action', hover)).isError).not.toBe(true)
    expect(parity.action).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'owner', workspaceId, action: { type: 'hover', selector: '#menu' } }))
    expect((await stableServer.call('owner', 'browser_close', { pageId })).isError).toBe(true)
  })

  it('closes a page by its ID and lists servers, bound to the calling thread', async () => {
    const browser = service()
    const server = createBrowserAgentServer(() => browser as unknown as BrowserService, undefined, true); servers.push(server)
    expect(decode(await server.call('owner', 'browser_close', { pageId }))).toEqual({ closed: pageId })
    expect(browser.agentClose).toHaveBeenCalledWith({ pageId, threadId: 'owner', workspaceId })
    expect((await server.call('owner', 'browser_close', { pageId, threadId: 'victim' })).isError).toBe(true)
    expect(decode(await server.call('owner', 'browser_servers', {}))).toEqual({ servers: [{ port: 5173, url: 'http://localhost:5173/', title: 'Vite', process: 'node' }] })
    browser.localServers.mockResolvedValueOnce({ ok: true, value: [] })
    expect(decode(await server.call('owner', 'browser_servers', {})).message).toContain('No web server started from Sotto')
  })

  it('offers a paired host no server listing', async () => {
    const browser = service()
    const server = createHostBrowserAgentServer(browser as unknown as BrowserAgentService, true); servers.push(server)
    expect((await server.call('owner', 'browser_servers', {})).isError).toBe(true)
    expect(browser.localServers).not.toHaveBeenCalled()
  })

  it('lists the stable catalog to a thread whose client asks for it compact, and the full one otherwise', async () => {
    const compact = [{ name: 'browser_open', description: 'stable', inputSchema: { type: 'object', properties: {} } }]
    const full = [...compact.map(tool => ({ ...tool, description: 'full' })), { name: 'browser_close', description: 'close', inputSchema: { type: 'object', properties: {} } }]
    const server = new BrowserAgentServer(full, vi.fn(), undefined, compact); servers.push(server)
    const list = async (endpoint: Awaited<ReturnType<BrowserAgentServer['mcpServer']>>) => (await (await fetch(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(endpoint.headers.map(header => [header.name, header.value])) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json()) as { result: { tools: { name: string; description: string }[] } }
    const antigravity = await server.mcpServer('agy-thread', { compact: true })
    expect((await list(antigravity)).result.tools.map(tool => `${tool.name}:${tool.description}`)).toEqual(['browser_open:stable'])
    const claude = await server.mcpServer('claude-thread')
    expect((await list(claude)).result.tools.map(tool => tool.name)).toEqual(['browser_open', 'browser_close'])
  })

  it('refuses a compact thread a full-catalog tool and a full-catalog action, over tools/call too', async () => {
    const browser = service()
    const server = createBrowserAgentServer(() => browser as unknown as BrowserService, undefined, true); servers.push(server)
    type Answer = { result?: { isError?: boolean }; error?: unknown }
    const call = async (endpoint: Awaited<ReturnType<typeof server.mcpServer>>, name: string, args: unknown): Promise<Answer> => (await (await fetch(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(endpoint.headers.map(header => [header.name, header.value])) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()) as Answer
    const direct = async (name: string, args: unknown): Promise<Answer> => ({ result: await server.call('owner', name, args) })
    const antigravity = await server.mcpServer('owner', { compact: true })
    const hover = { pageId, taskId, action: { type: 'hover', selector: '#menu' } }
    // A tool only the full catalog has is not there for this thread, whether asked over HTTP or directly.
    for (const result of [await call(antigravity, 'browser_close', { pageId }), await direct('browser_close', { pageId })]) expect(result.result?.isError ?? result.error !== undefined).toBe(true)
    expect(browser.agentClose).not.toHaveBeenCalled()
    for (const result of [await call(antigravity, 'browser_servers', {}), await direct('browser_servers', {})]) expect(result.result?.isError ?? result.error !== undefined).toBe(true)
    expect(browser.localServers).not.toHaveBeenCalled()
    // browser_action is in both catalogs: its arguments are read as the stable catalog's, so hover is refused.
    for (const result of [await call(antigravity, 'browser_action', hover), await direct('browser_action', hover)]) expect(result.result?.isError).toBe(true)
    expect(browser.action).not.toHaveBeenCalled()
    // A stable action still runs.
    expect((await call(antigravity, 'browser_action', { pageId, taskId, action: { type: 'inspect' } })).result?.isError).not.toBe(true)
    expect(browser.action).toHaveBeenCalledOnce()
    // The same thread asking again without compact gets the full catalog back.
    await server.mcpServer('owner')
    expect((await server.call('owner', 'browser_action', hover)).isError).not.toBe(true)
    expect(decode(await server.call('owner', 'browser_close', { pageId }))).toEqual({ closed: pageId })
  })

  it('lists no downloads to a compact thread, and names them without a path otherwise', async () => {
    const browser = { ...service(), agentDownloads: vi.fn(async () => [{ file: 'report.pdf', state: 'asking' as const, byAgent: true }]) }
    const server = createBrowserAgentServer(() => browser as unknown as BrowserService, undefined, true); servers.push(server)
    expect(decode(await server.call('owner', 'browser_pages', {})).downloads).toEqual([{ file: 'report.pdf', state: 'asking', byAgent: true }])
    await server.mcpServer('owner', { compact: true })
    expect(decode(await server.call('owner', 'browser_pages', {})).downloads).toBeUndefined()
  })

  it('asks for the compact catalog for an Antigravity thread alone, and for one argument otherwise', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-browser-compact-'))
    servers.push({ close: () => rm(root, { recursive: true, force: true }) })
    const registry = new ThreadRegistry(root)
    await registry.load()
    for (const provider of ['antigravity', 'claude']) {
      let given: BrowserAgentTools | undefined
      const inner = { useBrowserTools: (tools: BrowserAgentTools) => { given = tools } } as unknown as ProviderHost
      const host = new SottoThreadHost(provider, inner, registry)
      const mcpServer = vi.fn(async () => ({ name: 'sotto_browser', url: 'http://127.0.0.1:1/', headers: [] }))
      host.useBrowserTools({ definitions: [], call: vi.fn(), mcpServer } as unknown as BrowserAgentTools)
      const threadId = registry.bind(provider, `${provider}-session`, 'project').threadId
      await given!.mcpServer(`${provider}-session`)
      if (provider === 'antigravity') expect(mcpServer).toHaveBeenCalledWith(threadId, { compact: true })
      else { expect(mcpServer).toHaveBeenCalledWith(threadId); expect(mcpServer.mock.calls[0]).toHaveLength(1) }
    }
    await registry.flush().catch(() => undefined)
  })
})

describe('full-catalog actions and their permissions (ADR-0220)', () => {
  it('keeps the stable action schema to the stable actions', () => {
    for (const type of PARITY_ONLY_ACTIONS) expect(browserStableActionSchema.safeParse({ type }).success).toBe(false)
    expect(browserStableActionSchema.safeParse({ type: 'click', x: 1, y: 2 }).success).toBe(true)
  })

  it('reads targets by ref, selector or point, and refuses two at once', () => {
    expect(browserActionSchema.safeParse({ type: 'click', ref: 'e3', button: 'right', clickCount: 2, modifiers: ['Shift'] }).success).toBe(true)
    expect(browserActionSchema.safeParse({ type: 'click', selector: '#a', ref: 'e3' }).success).toBe(false)
    expect(browserActionSchema.safeParse({ type: 'type', selector: '#name', text: 'Rez', clear: true }).success).toBe(true)
    expect(browserActionSchema.safeParse({ type: 'wait_for', text: 'Saved', timeoutMs: 30_000 }).success).toBe(true)
    expect(browserActionSchema.safeParse({ type: 'wait_for', text: 'Saved', timeoutMs: 30_001 }).success).toBe(false)
    expect(browserActionSchema.safeParse({ type: 'upload', paths: Array.from({ length: 11 }, (_, index) => `${index}.txt`) }).success).toBe(false)
    expect(browserActionSchema.safeParse({ type: 'viewport', preset: 'iphone-12-pro', orientation: 'landscape' }).success).toBe(true)
    expect(browserActionSchema.safeParse({ type: 'viewport', fill: true }).success).toBe(true)
    expect(browserActionSchema.safeParse({ type: 'appearance', colorScheme: 'dark' }).success).toBe(true)
  })

  it('turns a preset on its side, and every preset is a phone or tablet layout', () => {
    expect(presetSize('iphone-12-pro')).toEqual({ width: 390, height: 844, mobile: true })
    expect(presetSize('iphone-12-pro', 'landscape')).toEqual({ width: 844, height: 390, mobile: true })
    expect(BROWSER_DEVICE_PRESETS.every(preset => preset.mobile)).toBe(true)
  })

  it('opens a server on this computer by its port', () => {
    expect(browserParityOpenInputSchema.safeParse({ port: 5173, description: 'Dev server' }).success).toBe(true)
    expect(browserParityOpenInputSchema.safeParse({ description: 'Nothing' }).success).toBe(false)
    expect(browserParityOpenInputSchema.safeParse({ url: 'http://localhost:1/', path: '/x', description: 'Both' }).success).toBe(false)
    expect(parityOpenUrl({ port: 5173 })).toBe('http://localhost:5173/')
    expect(parityOpenUrl({ port: 8443, protocol: 'https', path: '/app' })).toBe('https://localhost:8443/app')
    expect(parityOpenUrl({ url: 'https://example.com/' })).toBe('https://example.com/')
  })

  it('lets the browser grant answer actions as the user would, except upload, which always asks', () => {
    for (const type of ['navigate', 'click', 'type', 'tap', 'key', 'select', 'drag', 'evaluate', 'dialog']) expect(grantCovers(type)).toBe(true)
    for (const type of ['hover', 'scroll', 'snapshot', 'screenshot', 'wait_for', 'appearance', 'record_start']) expect(grantCovers(type)).toBe(false)
    expect(alwaysAsks('upload')).toBe(true)
    expect(alwaysAsks('click')).toBe(false)
  })
})
