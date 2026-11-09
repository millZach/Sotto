// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostBrowserService } from '../../../../src/host/browser/hostBrowserService'
import { HostBrowserMissing, NO_HOST_BROWSER, type HostBrowser, type HostBrowserPage, type HostPageState } from '../../../../src/host/browser/hostBrowser'
import { createHostBrowserAgentServer, hostBrowserToolDefinitions } from '../../../../src/main/tools/browserAgentTools'
import type { BrowserAgentResult, BrowserEvent } from '../../../../src/shared/browser'
import type { ToolsResult } from '../../../../src/shared/tools'

const workspaceId = 'a'.repeat(64)
const workspace = { threadId: 'thread-1', projectId: 'project', workingDirectory: '/work', workspaceId }
/** The threads the coordinator lists; a test takes one away to say it has gone. */
const listed = new Set<string>()
const files = { resolveWorkspace: async (threadId: string) => listed.has(threadId) ? { ok: true as const, value: workspace } : { ok: false as const, error: { code: 'thread-unavailable' as const, message: 'gone' } }, hasThread: (threadId: string) => listed.has(threadId) }

/** A page in a host's browser as the service sees it: its state moves when it is told to go somewhere. */
class FakePage {
  state: HostPageState = { url: 'about:blank', title: '', status: 'ready', error: null, canGoBack: false, canGoForward: false }
  closed = false
  readonly visits: string[] = []
  private readonly changes = new Set<(state: HostPageState) => void>()
  private readonly closes = new Set<() => void>()
  readonly automation = {
    observe: vi.fn(), clear: vi.fn(), dispose: vi.fn(),
    inspect: vi.fn(async () => JSON.stringify({ url: this.state.url, elements: [] })),
    capture: vi.fn(async (url: string) => ({ url, image: 'data:image/png;base64,YQ==', width: 1280, height: 800, element: null })),
    input: vi.fn(async () => undefined), target: vi.fn(async () => 'BUTTON|Sign in'),
    evidence: vi.fn(async () => ({ image: 'data:image/jpeg;base64,Yg==', width: 1280, height: 800 })), thumbnail: vi.fn(async () => 'data:image/jpeg;base64,Yw=='),
  }
  onChange(listener: (state: HostPageState) => void): () => void { this.changes.add(listener); return () => this.changes.delete(listener) }
  onClose(listener: () => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener) }
  async navigate(url: string): Promise<void> { this.visits.push(url); this.set({ url, status: 'loading', error: null }); this.set({ status: 'ready', title: `Title of ${url}` }) }
  async back(): Promise<void> { /* No history in the fake. */ }
  async forward(): Promise<void> { /* No history in the fake. */ }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; for (const listener of [...this.closes]) listener() }
  set(change: Partial<HostPageState>): void { this.state = { ...this.state, ...change }; for (const listener of [...this.changes]) listener(this.state) }
}

function fakeBrowser(missing = false) {
  const pages: FakePage[] = []
  const browser = {
    open: vi.fn(async () => { if (missing) throw new HostBrowserMissing(); const page = new FakePage(); pages.push(page); return page as unknown as HostBrowserPage }),
    dispose: vi.fn(async () => undefined), available: vi.fn(async () => !missing),
  }
  return { browser: browser as unknown as HostBrowser & typeof browser, pages }
}

const services: HostBrowserService[] = []
afterEach(async () => { for (const service of services.splice(0)) await service.shutDown(); vi.useRealTimers() })
function setup(options: { withoutAsking?: boolean; missing?: boolean } = {}) {
  listed.clear(); listed.add(workspace.threadId)
  const { browser, pages } = fakeBrowser(options.missing)
  const events: BrowserEvent[] = []
  const saved: boolean[] = []
  const service = new HostBrowserService({ browser, files, emit: event => events.push(event), withoutAsking: options.withoutAsking ?? true, saveWithoutAsking: async value => { saved.push(value) } })
  services.push(service)
  return { service, browser, pages, events, saved }
}
const value = <T>(result: ToolsResult<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value }
const open = (service: HostBrowserService, url = 'http://127.0.0.1:5173/') => service.agentOpen({ threadId: workspace.threadId, workspaceId, url, description: 'Check sign in' })

describe('a host\'s browser service (ADR-0198)', () => {
  it('opens, shares and drives a page without asking while the host holds the setting on', async () => {
    const { service, pages } = setup()
    const opened = value(await open(service))
    expect(opened.approvalRequired).toBe(false)
    expect(pages[0]!.visits).toEqual(['http://127.0.0.1:5173/'])
    const listing = value(await service.list({ threadId: workspace.threadId }))
    expect(listing.pages[0]).toMatchObject({ url: 'http://127.0.0.1:5173/', status: 'ready', title: 'Title of http://127.0.0.1:5173/', sharedOrigin: 'http://127.0.0.1:5173' })
    expect(listing.grant?.source).toBe('settings')

    const target = { threadId: workspace.threadId, workspaceId, pageId: opened.task.pageId, taskId: opened.task.id }
    const clicked = value(await service.action({ ...target, action: { type: 'click', x: 10, y: 10 } }))
    expect(clicked.approvalRequired).toBe(false)
    expect(pages[0]!.automation.input).toHaveBeenCalledOnce()
    const shot = value(await service.action({ ...target, action: { type: 'screenshot' } }))
    expect(shot.image).toBe('data:image/png;base64,YQ==')
    expect(shot.task.evidence?.[0]?.image).toBe('data:image/jpeg;base64,Yg==')
    expect(shot.task.thumbnail).toBe('data:image/jpeg;base64,Yw==')
  })

  it('holds an agent\'s request for the user while the setting is off, and ends it after five minutes', async () => {
    vi.useFakeTimers()
    const { service, pages } = setup({ withoutAsking: false })
    const opened = value(await open(service))
    expect(opened.approvalRequired).toBe(true)
    expect(opened.task.pendingAction?.description).toBe('Open and share this page with the thread: http://127.0.0.1:5173/')
    expect(pages[0]!.visits).toEqual([])
    const waiting = service.waitForAction(opened.task.id, opened.task.pendingAction!.id)
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10)
    const ended = await waiting
    expect(ended?.pendingAction).toBeNull()
    expect(ended?.output).toBe('This browser request expired. Ask the user before requesting it again.')
    expect(pages[0]!.visits).toEqual([])
  })

  it('runs a waiting request once the user allows it, and lets a desktop\'s setting answer what was waiting', async () => {
    const { service, pages, saved, events } = setup({ withoutAsking: false })
    const first = value(await open(service))
    const answered = value(await service.answerAction({ threadId: workspace.threadId, workspaceId, pageId: first.task.pageId, taskId: first.task.id, actionId: first.task.pendingAction!.id, allow: true }))
    expect(answered.steps.at(-1)?.action).toBe('navigate')
    expect(pages[0]!.visits).toEqual(['http://127.0.0.1:5173/'])

    const second = value(await open(service, 'http://127.0.0.1:4000/'))
    expect(second.approvalRequired).toBe(true)
    await service.setWithoutAsking(true)
    expect(saved).toEqual([true])
    expect(service.withoutAsking).toBe(true)
    await vi.waitFor(() => expect(pages[1]!.visits).toEqual(['http://127.0.0.1:4000/']))
    expect(events).toContainEqual(expect.objectContaining({ type: 'browser-grant', threadId: workspace.threadId, grant: expect.objectContaining({ source: 'settings' }) }))
    await service.setWithoutAsking(true)
    expect(saved).toEqual([true])
  })

  it('tries a failed save of the setting again when a desktop sends the same value', async () => {
    const { browser } = fakeBrowser()
    const written: boolean[] = []
    let failing = true
    const service = new HostBrowserService({ browser, files, emit: () => undefined, withoutAsking: true,
      saveWithoutAsking: async value => { if (failing) throw new Error('disk full'); written.push(value) } })
    services.push(service)
    await expect(service.setWithoutAsking(false)).rejects.toThrow('disk full')
    expect(service.withoutAsking).toBe(false)
    failing = false
    await service.setWithoutAsking(false)
    expect(written).toEqual([false])
    await service.setWithoutAsking(false)
    expect(written).toEqual([false])
  })

  it('runs nothing a thread that has gone left waiting when the setting turns on, and ends its grant', async () => {
    const { service, pages, events } = setup({ withoutAsking: false })
    value(await open(service))
    listed.delete(workspace.threadId)
    events.length = 0
    await service.setWithoutAsking(true)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(pages[0]!.visits).toEqual([])
    expect(events.filter(event => event.type === 'browser-grant')).toEqual([{ type: 'browser-grant', threadId: workspace.threadId, grant: null }])
  })

  it('follows the page to where it goes, and ends sharing at another site without a grant', async () => {
    const { service, pages } = setup({ withoutAsking: false })
    const opened = value(await open(service))
    value(await service.answerAction({ threadId: workspace.threadId, workspaceId, pageId: opened.task.pageId, taskId: opened.task.id, actionId: opened.task.pendingAction!.id, allow: true }))
    pages[0]!.set({ url: 'http://127.0.0.1:5173/signed-in', status: 'loading' })
    pages[0]!.set({ status: 'ready' })
    expect(value(await service.list({ threadId: workspace.threadId })).pages[0]).toMatchObject({ url: 'http://127.0.0.1:5173/signed-in', sharedOrigin: 'http://127.0.0.1:5173' })
    pages[0]!.set({ url: 'https://elsewhere.example/', status: 'loading' })
    expect(value(await service.list({ threadId: workspace.threadId })).pages[0]).toMatchObject({ url: 'https://elsewhere.example/', sharedOrigin: null })
    const refused = await service.action({ threadId: workspace.threadId, workspaceId, pageId: opened.task.pageId, taskId: opened.task.id, action: { type: 'inspect' } })
    expect(refused.ok).toBe(false)
  })

  it('fails a page\'s task and tells the window when the page closes on its own', async () => {
    const { service, pages, events } = setup()
    const opened = value(await open(service))
    await pages[0]!.close()
    expect(value(await service.list({ threadId: workspace.threadId })).pages).toEqual([])
    expect(value(await service.tasks({ threadId: workspace.threadId }))[0]).toMatchObject({ status: 'failed', summary: 'This browser page closed.' })
    expect(events).toContainEqual({ type: 'closed', threadId: workspace.threadId, workspaceId, pageId: opened.task.pageId })
  })

  it('says whether the host has a browser, without starting one', async () => {
    expect(value(await setup().service.available({ threadId: workspace.threadId }))).toEqual({ available: true })
    const missing = setup({ missing: true })
    expect(value(await missing.service.available({ threadId: workspace.threadId }))).toEqual({ available: false })
    expect(missing.browser.open).not.toHaveBeenCalled()
  })

  it('closes every page and the browser when the host stops', async () => {
    const { service, browser, pages } = setup()
    value(await open(service))
    await service.shutDown()
    expect(pages[0]!.closed).toBe(true)
    expect(browser.dispose).toHaveBeenCalledOnce()
    expect((await open(service)).ok).toBe(false)
  })
})

describe('a host thread\'s browser tools', () => {
  it('offers the six browser tools and none of the test iPhone\'s or the cloud iPhone\'s', () => {
    expect(hostBrowserToolDefinitions.map(tool => tool.name)).toEqual(['browser_pages', 'browser_open', 'browser_start', 'browser_action', 'browser_status', 'browser_finish'])
  })

  it('says in plain words that the host has no browser, and opens nothing', async () => {
    const { service, browser } = setup({ missing: true })
    const server = createHostBrowserAgentServer(service)
    try {
      const result = await server.call(workspace.threadId, 'browser_open', { url: 'http://127.0.0.1:5173/', description: 'Check sign in' })
      expect(result.isError).toBe(true)
      expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ message: NO_HOST_BROWSER })
      expect(browser.open).toHaveBeenCalledOnce()
      expect(value(await service.list({ threadId: workspace.threadId })).pages).toEqual([])
      expect((await server.call(workspace.threadId, 'iphone_open', { url: 'http://127.0.0.1:5173/', description: 'Phone' })).isError).toBe(true)
    } finally { await server.close() }
  })

  it('opens a page through the tool and returns its task', async () => {
    const { service } = setup()
    const server = createHostBrowserAgentServer(service)
    try {
      const result = await server.call(workspace.threadId, 'browser_open', { url: 'http://127.0.0.1:5173/', description: 'Check sign in' })
      expect(result.isError).toBeUndefined()
      const body = JSON.parse((result.content[0] as { text: string }).text) as { task: BrowserAgentResult['task']; approvalRequired: boolean }
      expect(body.approvalRequired).toBe(false)
      expect(body.task.status).toBe('working')
    } finally { await server.close() }
  })
})
