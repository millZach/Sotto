// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { BaseWindow, WebContentsView, type BrowserWindow } from 'electron'
import { BrowserService } from '../../../src/main/tools/browser'
import { FilesService } from '../../../src/main/files/service'
import type { ToolsResult } from '../../../src/shared/tools'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    url = ''; destroyed = false
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    debugger = Object.assign(new EventEmitter(), { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async (method: string) => method === 'Page.getLayoutMetrics' ? { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 } } : method === 'Page.captureScreenshot' ? { data: 'YQ==' } : method === 'Accessibility.getFullAXTree' ? { nodes: [{ role: { value: 'button' }, name: { value: 'Save' } }] } : method === 'DOM.getNodeForLocation' ? { backendNodeId: 7 } : method === 'DOM.describeNode' ? { node: { backendNodeId: 7, nodeName: 'INPUT', attributes: ['aria-label', 'Name', 'type', 'text'] } } : method === 'Runtime.evaluate' ? { result: { objectId: 'input-1' } } : {}) })
    capturePage = vi.fn(async () => ({ isEmpty: () => false, getSize: () => ({ width: 1280, height: 800 }), toDataURL: () => 'data:image/png;base64,YQ==', resize: () => ({ toJPEG: () => Buffer.from('thumbnail') }) }))
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
  const makeImage = (buffer: Buffer, width = 1280, height = 800) => ({
    isEmpty: () => false, getSize: () => ({ width, height }), toDataURL: () => `data:image/png;base64,${buffer.toString('base64')}`,
    toBitmap: () => buffer, toJPEG: () => buffer,
    crop: (region: { width: number; height: number }) => makeImage(buffer, region.width, region.height),
    resize: (size: { width?: number; height?: number }) => makeImage(buffer, size.width ?? width, size.height ?? height),
  })
  class CaptureWindow {
    destroyed = false
    children = new Set<unknown>()
    contentView = { addChildView: (view: unknown) => this.children.add(view), removeChildView: (view: unknown) => this.children.delete(view) }
    isDestroyed = () => this.destroyed
    showInactive = vi.fn()
    destroy = () => { this.destroyed = true; this.children.clear() }
  }
  return { BaseWindow: vi.fn(CaptureWindow), screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] }, nativeImage: { createFromDataURL: vi.fn((data: string) => makeImage(Buffer.from(data.split(',')[1]!, 'base64'))), createFromBuffer: vi.fn((buffer: Buffer) => makeImage(buffer)) }, WebContentsView: vi.fn(class { webContents = new Contents(); bounds = { x: 0, y: 0, width: 1280, height: 800 }; setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = bounds }); getBounds = () => this.bounds }), session: { fromPartition: () => new IsolatedSession() } }
})
const unwrap = <T>(result: ToolsResult<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.clearAllMocks() })
describe('browser service lifecycle', () => {
  it.each(['hide', 'close'] as const)('does not cancel a pending page mount when the previous page finishes %s', async action => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-browser-unit-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory: directory }), copyPath: vi.fn(), reveal: vi.fn() })
    const attached = new Set<WebContentsView>()
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, getContentSize: () => [1200, 800],
      webContents: Object.assign(new EventEmitter(), { getZoomFactor: () => 1 }),
      contentView: { addChildView: (view: WebContentsView) => attached.add(view), removeChildView: (view: WebContentsView) => attached.delete(view) },
    }) as unknown as BrowserWindow
    const service = new BrowserService({ files, getWindow: () => window, emit: vi.fn(), openExternal: vi.fn(), destination: async () => 'external', byDefault: () => false })
    cleanup.push(async () => service.dispose())
    const owner = unwrap(await service.list({ threadId: 'a' })).workspace
    const target = { threadId: 'a', workspaceId: owner.workspaceId }
    const first = unwrap(await service.create({ ...target, url: 'http://localhost/first' }))
    const second = unwrap(await service.create({ ...target, url: 'http://localhost/second' }))
    const bounds = { x: 400, y: 100, width: 600, height: 500 }
    unwrap(await service.mount({ ...target, pageId: first.id, bounds }))
    let finishValidation!: (value: Awaited<ReturnType<FilesService['resolveWorkspace']>>) => void
    vi.spyOn(files, 'resolveWorkspace').mockImplementationOnce(() => new Promise(resolve => { finishValidation = resolve }))
    const mounting = service.mount({ ...target, pageId: second.id, bounds })
    if (action === 'hide') unwrap(await service.mount({ ...target, pageId: first.id, bounds: null }))
    else unwrap(await service.close({ ...target, pageId: first.id }))
    finishValidation({ ok: true, value: owner })
    unwrap(await mounting)
    expect(attached).toEqual(new Set([vi.mocked(WebContentsView).mock.results[1]!.value]))
  })
  it('keeps failed navigation unavailable when Chromium finishes an error document, then supports explicit reload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-browser-unit-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory: directory }), copyPath: vi.fn(), reveal: vi.fn() })
    const emit = vi.fn(), openExternal = vi.fn().mockResolvedValue(undefined)
    const service = new BrowserService({ files, getWindow: () => null, emit, openExternal, destination: async () => 'external', byDefault: () => false })
    cleanup.push(async () => service.dispose())
    const owner = unwrap(await service.list({ threadId: 'a' })).workspace
    const target = { threadId: 'a', workspaceId: owner.workspaceId }
    const page = unwrap(await service.create({ ...target, url: 'http://127.0.0.1:12345/' }))
    const view = vi.mocked(WebContentsView).mock.results[0]!.value as WebContentsView
    view.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', page.url, true)
    view.webContents.emit('did-finish-load')
    expect(unwrap(await service.list({ threadId: 'a' })).pages[0]!.status).toBe('unavailable')
    unwrap(await service.reload({ ...target, pageId: page.id }))
    view.webContents.emit('did-finish-load')
    expect(unwrap(await service.list({ threadId: 'a' })).pages[0]).toMatchObject({ status: 'ready', error: null })
    await service.openLink({ url: 'https://example.com' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
    const embedded = unwrap(await service.openLink({ url: 'https://example.com', destination: 'embedded', target }))
    expect(embedded.destination).toBe('embedded'); expect(embedded.page).toBeDefined()
    expect(await service.navigate({ ...target, threadId: 'b', pageId: page.id, url: page.url })).toMatchObject({ ok: false, error: { code: 'page-unavailable' } })
    unwrap(await service.close({ ...target, pageId: page.id }))
    const eventCount = emit.mock.calls.length
    view.webContents.emit('did-finish-load')
    expect(emit.mock.calls.length).toBe(eventCount)
    expect(unwrap(await service.list({ threadId: 'a' })).pages).toHaveLength(1)
  })
})

async function browserFixture(withWindow = false, gone: ReadonlySet<string> = new Set(), byDefault: () => boolean = () => false) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-browser-actions-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const files = new FilesService({ resolveBinding: threadId => gone.has(threadId) ? null : ({ threadId, projectId: 'p', workingDirectory: directory }), copyPath: vi.fn(), reveal: vi.fn() })
  const emit = vi.fn(), attached = new Set<WebContentsView>()
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentSize: () => [1200, 800], webContents: Object.assign(new EventEmitter(), { getZoomFactor: () => 1 }), contentView: { addChildView: (view: WebContentsView) => attached.add(view), removeChildView: (view: WebContentsView) => attached.delete(view) } }) as unknown as BrowserWindow
  const service = new BrowserService({ files, getWindow: () => withWindow ? window : null, emit, openExternal: vi.fn(), destination: async () => 'embedded', byDefault })
  cleanup.push(async () => service.dispose())
  const owner = unwrap(await service.list({ threadId: 'a' })).workspace
  const target = { threadId: 'a', workspaceId: owner.workspaceId }
  const page = unwrap(await service.create({ ...target, url: 'http://localhost:4321/' }))
  const view = vi.mocked(WebContentsView).mock.results.at(-1)!.value as WebContentsView
  return { service, target: { ...target, pageId: page.id }, view, emit, attached }
}

describe('browser agent boundaries', () => {
  it('requires explicit sharing and keeps tasks and pages with their owning thread', async () => {
    const { service, target } = await browserFixture()
    expect(await service.startTask({ ...target, description: 'Check the form' })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    unwrap(await service.share({ ...target, enabled: true }))
    const task = unwrap(await service.startTask({ ...target, description: 'Check the form' }))
    expect(await service.action({ ...target, threadId: 'b', taskId: task.id, action: { type: 'inspect' } })).toMatchObject({ ok: false, error: { code: 'page-unavailable' } })
    expect(unwrap(await service.tasks({ threadId: 'b' }))).toEqual([])
    expect(unwrap(await service.list({ threadId: 'b' })).pages).toEqual([])
    const result = unwrap(await service.action({ ...target, taskId: task.id, action: { type: 'inspect' } }))
    expect(JSON.parse(result.output!).nodes).toEqual([{ role: 'button', name: 'Save' }])
    expect(result.task.thumbnail).toMatch(/^data:image\/jpeg/)
  })
  it('opens an agent page only after the user answers its exact navigation request', async () => {
    const { service, target } = await browserFixture()
    const result = unwrap(await service.agentOpen({ threadId: target.threadId, workspaceId: target.workspaceId, url: 'http://localhost:4555/', description: 'Check the new app' }))
    const view = vi.mocked(WebContentsView).mock.results.at(-1)!.value as WebContentsView
    expect(view.webContents.getURL()).toBe('')
    expect(result.approvalRequired).toBe(true)
    expect(result.task.pendingAction?.description).toContain('Open and share')
    const request = { ...target, pageId: result.task.pageId, taskId: result.task.id, actionId: result.task.pendingAction!.id, allow: true }
    unwrap(await service.answerAction(request))
    expect(view.webContents.getURL()).toBe('http://localhost:4555/')
    expect(unwrap(await service.list({ threadId: target.threadId })).pages.at(-1)?.sharedOrigin).toBe('http://localhost:4555')
    expect(await service.answerAction(request)).toMatchObject({ ok: false, error: { code: 'blocked' } })
  })
  it('requires an exact answer for input and invalidates it on pause, navigation, and expiry', async () => {
    const { service, target, view } = await browserFixture()
    unwrap(await service.share({ ...target, enabled: true }))
    const task = unwrap(await service.startTask({ ...target, description: 'Test saving' }))
    const request = { ...target, taskId: task.id }
    const pending = unwrap(await service.action({ ...request, action: { type: 'click', x: 20, y: 30 } }))
    expect(view.webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything())
    unwrap(await service.controlTask({ ...request, control: 'pause' }))
    expect(await service.action({ ...request, action: { type: 'screenshot' } })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    unwrap(await service.controlTask({ ...request, control: 'resume' }))
    expect(await service.answerAction({ ...request, actionId: pending.task.pendingAction!.id, allow: true })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    const stale = unwrap(await service.action({ ...request, action: { type: 'type', text: 'hello' } }))
    view.webContents.emit('did-start-navigation', {}, 'http://localhost:4321/next', false, true)
    expect(await service.answerAction({ ...request, actionId: stale.task.pendingAction!.id, allow: true })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    const expired = unwrap(await service.action({ ...request, action: { type: 'click', x: 2, y: 3 } }))
    const now = vi.spyOn(Date, 'now').mockReturnValue(expired.task.pendingAction!.expiresAt + 1)
    expect(await service.answerAction({ ...request, actionId: expired.task.pendingAction!.id, allow: true })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    now.mockRestore()
  })
  it('executes allowed input once and records viewport-specific evidence and explicit gaps', async () => {
    const { service, target, view } = await browserFixture()
    unwrap(await service.share({ ...target, enabled: true }))
    const task = unwrap(await service.startTask({ ...target, description: 'Check saving' }))
    const request = { ...target, taskId: task.id }
    const pending = unwrap(await service.action({ ...request, action: { type: 'click', x: 20, y: 30 } }))
    const continuation = service.waitForAction(task.id, pending.task.pendingAction!.id)
    unwrap(await service.answerAction({ ...request, actionId: pending.task.pendingAction!.id, allow: true }))
    expect((await continuation)?.steps.at(-1)?.action).toBe('click')
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 30, button: 'left', clickCount: 1 })
    unwrap(await service.action({ ...request, action: { type: 'viewport', width: 820, height: 560 } }))
    const shot = unwrap(await service.action({ ...request, action: { type: 'screenshot' } }))
    expect(shot.task.evidence).toHaveLength(1)
    expect(shot.task.evidence![0]).toMatchObject({ viewport: { width: 820, height: 560 }, url: 'http://localhost:4321/' })
    expect(shot.image).toMatch(/^data:image\/png/)
    expect(shot.task.steps.at(-1)).toMatchObject({ action: 'screenshot', viewport: { width: 820, height: 560 }, url: 'http://localhost:4321/' })
    const final = unwrap(await service.finishTask({ ...request, status: 'completed', summary: 'Save button checked.', unchecked: ['Reload persistence'] }))
    expect(final.unchecked).toEqual(['Reload persistence'])
    expect(await service.action({ ...request, action: { type: 'inspect' } })).toMatchObject({ ok: false, error: { code: 'blocked' } })
  })
  it('revokes evidence and blocks in-flight captures from releasing page data', async () => {
    const { service, target, view } = await browserFixture()
    unwrap(await service.share({ ...target, enabled: true }))
    const task = unwrap(await service.startTask({ ...target, description: 'Check the page' }))
    let release!: (value: { data: string }) => void
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => args[0] === 'Page.captureScreenshot' ? new Promise(resolve => { release = resolve }) : original(...args))
    const operation = service.action({ ...target, taskId: task.id, action: { type: 'screenshot' } })
    await vi.waitFor(() => expect(release).toBeDefined())
    unwrap(await service.share({ ...target, enabled: false }))
    release({ data: 'YQ==' })
    expect(await operation).toMatchObject({ ok: false, error: { code: 'blocked' } })
    const latest = unwrap(await service.tasks({ threadId: target.threadId }))[0]!
    expect(latest.thumbnail).toBeNull()
    expect(latest.status).toBe('paused')
    unwrap(await service.controlTask({ ...target, taskId: task.id, control: 'resume' }))
    expect(await service.action({ ...target, taskId: task.id, action: { type: 'inspect' } })).toMatchObject({ ok: false, error: { code: 'blocked' } })
  })
  it('revokes sharing across origins and fails the task when its page closes', async () => {
    const { service, target, view } = await browserFixture()
    unwrap(await service.share({ ...target, enabled: true }))
    const task = unwrap(await service.startTask({ ...target, description: 'Check the page' }))
    view.webContents.emit('did-start-navigation', {}, 'https://example.com/', false, true)
    expect(await service.action({ ...target, taskId: task.id, action: { type: 'inspect' } })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    unwrap(await service.close(target))
    expect(unwrap(await service.tasks({ threadId: target.threadId }))[0]).toMatchObject({ status: 'failed', thumbnail: null, pendingAction: null })
  })
  it('refuses an approved coordinate when the target changes without navigating', async () => {
    const { service, target, view } = await browserFixture()
    unwrap(await service.share({ ...target, enabled: true }))
    const task = unwrap(await service.startTask({ ...target, description: 'Check the page' }))
    const request = { ...target, taskId: task.id }
    const pending = unwrap(await service.action({ ...request, action: { type: 'click', x: 20, y: 30 } }))
    vi.mocked(view.webContents.debugger.sendCommand).mockResolvedValueOnce({ backendNodeId: 8 }).mockResolvedValueOnce({ node: { backendNodeId: 8, nodeName: 'BUTTON', attributes: ['aria-label', 'Delete'] } })
    expect(await service.answerAction({ ...request, actionId: pending.task.pendingAction!.id, allow: true })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    expect(view.webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything())
  })

  it('settles pending provider calls when sharing is revoked or the host shuts down', async () => {
    const { service, target } = await browserFixture()
    unwrap(await service.share({ ...target, enabled: true }))
    const task = unwrap(await service.startTask({ ...target, description: 'Check the page' }))
    const request = { ...target, taskId: task.id }
    const pending = unwrap(await service.action({ ...request, action: { type: 'click', x: 20, y: 30 } }))
    const waiting = service.waitForAction(task.id, pending.task.pendingAction!.id)
    unwrap(await service.share({ ...target, enabled: false }))
    expect((await waiting)?.status).toBe('paused')
    unwrap(await service.share({ ...target, enabled: true }))
    unwrap(await service.controlTask({ ...request, control: 'resume' }))
    const next = unwrap(await service.action({ ...request, action: { type: 'click', x: 20, y: 30 } }))
    const shutdown = service.waitForAction(task.id, next.task.pendingAction!.id)
    service.dispose()
    expect(await shutdown).toBeNull()
  })
  it('expires pending provider calls without polling or authorizing their action', async () => {
    const { service, target, view } = await browserFixture()
    unwrap(await service.share({ ...target, enabled: true }))
    const task = unwrap(await service.startTask({ ...target, description: 'Check the page' }))
    try {
      vi.useFakeTimers()
      const pending = unwrap(await service.action({ ...target, taskId: task.id, action: { type: 'click', x: 20, y: 30 } }))
      const waiting = service.waitForAction(task.id, pending.task.pendingAction!.id)
      await vi.advanceTimersByTimeAsync(300_001)
      expect(await waiting).toMatchObject({ pendingAction: null, output: expect.stringContaining('expired') })
      expect(view.webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything())
    } finally { vi.useRealTimers() }
  })
  it('refuses point feedback when the selected element changed at the same URL', async () => {
    const { service, target, view } = await browserFixture()
    const capture = unwrap(await service.capture(target))
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    const lookups = [
      { element: { tag: 'button', role: '', name: 'Save', text: 'Save', selector: '#save' }, bounds: { x: 0, y: 0, width: 100, height: 40 } },
      { element: { tag: 'button', role: '', name: 'Save anyway', text: 'Save anyway', selector: '#save-anyway' }, bounds: { x: 0, y: 0, width: 100, height: 40 } },
    ]
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => args[0] === 'Runtime.evaluate' ? { result: { value: lookups.shift() ?? lookups[0] } } : original(...args))
    expect(await service.capture({ ...target, captureId: capture.captureId, point: { x: 10, y: 10 } })).toMatchObject({ ok: false, error: { code: 'blocked' } })
  })

  it('crops the saved feedback region without reading a changing live page', async () => {
    const { service, target, view } = await browserFixture()
    const capture = unwrap(await service.capture(target))
    const command = vi.mocked(view.webContents.debugger.sendCommand)
    command.mockClear()
    const selected = unwrap(await service.capture({ ...target, captureId: capture.captureId, region: { x: 10, y: 20, width: 100, height: 60 } }))
    expect(selected).toMatchObject({ image: capture.image, width: 100, height: 60, element: null, url: capture.url })
    expect(command).not.toHaveBeenCalled()
  })

  it('returns the saved capture with the element when it still answers at the point', async () => {
    const { service, target, view } = await browserFixture()
    const capture = unwrap(await service.capture(target))
    const command = vi.mocked(view.webContents.debugger.sendCommand)
    const original = command.getMockImplementation()!
    command.mockImplementation(async (...args) => args[0] === 'Runtime.evaluate' ? { result: { value: { element: { tag: 'button', role: '', name: 'Save', text: 'Save', selector: '#save' }, bounds: { x: 10, y: 20, width: 100, height: 40 } } } } : original(...args))
    command.mockClear()
    const selected = unwrap(await service.capture({ ...target, captureId: capture.captureId, point: { x: 30, y: 30 } }))
    expect(selected).toMatchObject({ image: capture.image, url: capture.url, element: { name: 'Save', selector: '#save' } })
    expect(command.mock.calls.filter(call => call[0] === 'Page.captureScreenshot')).toHaveLength(0)
    expect(command.mock.calls.filter(call => call[0] === 'Runtime.evaluate')).toHaveLength(2)
  })

  it('derives recorded evidence and preview from the exact image returned to the agent', async () => {
    const { service, target, view } = await browserFixture()
    unwrap(await service.share({ ...target, enabled: true }))
    const task = unwrap(await service.startTask({ ...target, description: 'Check screenshot' }))
    const result = unwrap(await service.action({ ...target, taskId: task.id, action: { type: 'screenshot' } }))
    expect(result.image?.split(',')[1]).toBe(result.task.evidence?.[0]?.image.split(',')[1])
    expect(result.image?.split(',')[1]).toBe(result.task.thumbnail?.split(',')[1])
    expect(vi.mocked(view.webContents.debugger.sendCommand).mock.calls.filter(call => call[0] === 'Page.captureScreenshot')).toHaveLength(1)
  })

  it.each([
    { nodeName: 'IFRAME', attributes: [] },
    { nodeName: 'CUSTOM-EDITOR', attributes: ['contenteditable', 'true'], shadowRoots: [{ shadowRootType: 'closed' }] },
  ])('refuses typing approval through an ambiguous focused host: $nodeName', async node => {
    const { service, target, view } = await browserFixture()
    unwrap(await service.share({ ...target, enabled: true }))
    const task = unwrap(await service.startTask({ ...target, description: 'Check the form' }))
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => args[0] === 'DOM.describeNode' ? { node: { backendNodeId: 7, ...node } } : original(...args))
    expect(await service.action({ ...target, taskId: task.id, action: { type: 'type', text: 'hello' } })).toMatchObject({ ok: false })
    expect(unwrap(await service.tasks({ threadId: target.threadId }))[0]?.pendingAction).toBeNull()
    expect(view.webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything())
  })

  it.each([false, true])('cleans up a hidden capture lease without detaching a newly visible page: mount=%s', async mount => {
    const { service, target, view, attached } = await browserFixture(true)
    let release!: (value: { data: string }) => void
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => args[0] === 'Page.captureScreenshot' ? new Promise(resolve => { release = resolve }) : original(...args))
    const capture = service.capture(target)
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(attached.has(view)).toBe(false)
    const captureWindow = vi.mocked(BaseWindow).mock.results.at(-1)!.value as BaseWindow
    expect(vi.mocked(BaseWindow).mock.calls.at(-1)?.[0]).toMatchObject({ x: 2020, y: 1180, focusable: false, skipTaskbar: true })
    expect(view.getBounds().x).toBe(0)
    const bounds = { x: 100, y: 100, width: 600, height: 400 }
    if (mount) unwrap(await service.mount({ ...target, bounds }))
    release({ data: 'YQ==' })
    unwrap(await capture)
    expect(attached.has(view)).toBe(mount)
    expect(captureWindow.isDestroyed()).toBe(true)
    expect(view.getBounds()).toEqual(mount ? bounds : { x: 0, y: 0, width: 1280, height: 800 })
    expect(view.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
  })

  it('allows a fresh initial navigation request after denial without granting page access', async () => {
    const { service, target } = await browserFixture()
    const opened = unwrap(await service.agentOpen({ threadId: target.threadId, workspaceId: target.workspaceId, url: 'http://localhost:4555/', description: 'Check the app' }))
    const request = { ...target, pageId: opened.task.pageId, taskId: opened.task.id }
    unwrap(await service.answerAction({ ...request, actionId: opened.task.pendingAction!.id, allow: false }))
    expect(await service.action({ ...request, action: { type: 'inspect' } })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    const retried = unwrap(await service.action({ ...request, action: { type: 'navigate', url: 'http://localhost:4555/' } }))
    expect(retried.task.pendingAction!.id).not.toBe(opened.task.pendingAction!.id)
    unwrap(await service.answerAction({ ...request, actionId: retried.task.pendingAction!.id, allow: true }))
    expect(unwrap(await service.list({ threadId: target.threadId })).pages.at(-1)?.sharedOrigin).toBe('http://localhost:4555')
  })
  it.each(['navigate', 'reload'] as const)('lets a user open and then explicitly share an initially pending page with %s', async method => {
    const { service, target } = await browserFixture()
    const opened = unwrap(await service.agentOpen({ threadId: target.threadId, workspaceId: target.workspaceId, url: 'http://localhost:4555/', description: 'Check the app' }))
    const request = { ...target, pageId: opened.task.pageId }
    if (method === 'navigate') unwrap(await service.navigate({ ...request, url: 'http://localhost:4555/' }))
    else unwrap(await service.reload(request))
    expect(unwrap(await service.list({ threadId: target.threadId })).pages.at(-1)?.sharedOrigin).toBeNull()
    expect(unwrap(await service.share({ ...request, enabled: true })).sharedOrigin).toBe('http://localhost:4555')
  })

})

describe('browser grant (ADR-0029)', () => {
  const lastView = (): WebContentsView => vi.mocked(WebContentsView).mock.results.at(-1)!.value as WebContentsView
  async function grantThread(service: BrowserService, target: { threadId: string; workspaceId: string }) {
    const opened = unwrap(await service.agentOpen({ ...target, url: 'http://localhost:4555/', description: 'Check the app' }))
    const request = { ...target, pageId: opened.task.pageId, taskId: opened.task.id }
    unwrap(await service.answerAction({ ...request, actionId: opened.task.pendingAction!.id, allow: true, forThread: true }))
    return request
  }

  it('opens this page and later ones for the thread without asking, shared exactly as Open and share would', async () => {
    const { service, target, emit } = await browserFixture()
    const owner = { threadId: target.threadId, workspaceId: target.workspaceId }
    await grantThread(service, owner)
    expect(lastView().webContents.getURL()).toBe('http://localhost:4555/')
    expect(emit).toHaveBeenCalledWith({ type: 'browser-grant', threadId: 'a', grant: { grantedAt: expect.any(Number), source: 'user' } })
    expect(unwrap(await service.list({ threadId: 'a' })).grant).toEqual({ grantedAt: expect.any(Number), source: 'user' })
    const next = unwrap(await service.agentOpen({ ...owner, url: 'http://localhost:4600/', description: 'Check the settings page' }))
    expect(next.approvalRequired).toBe(false)
    expect(next.task.pendingAction).toBeNull()
    expect(next.task.steps.at(-1)).toMatchObject({ action: 'navigate', status: 'completed', detail: expect.stringContaining('Not asked: you let this thread use the browser without asking.') })
    expect(lastView().webContents.getURL()).toBe('http://localhost:4600/')
    expect(unwrap(await service.list({ threadId: 'a' })).pages.find(page => page.id === next.task.pageId)?.sharedOrigin).toBe('http://localhost:4600')
  })

  it('is on by default: every action runs without a pending action, until the setting is off', async () => {
    const { service, target } = await browserFixture(false, new Set(), () => true)
    const opened = unwrap(await service.agentOpen({ threadId: target.threadId, workspaceId: target.workspaceId, url: 'http://localhost:4555/', description: 'Check the app' }))
    expect(opened.approvalRequired).toBe(false)
    const request = { threadId: target.threadId, workspaceId: target.workspaceId, pageId: opened.task.pageId, taskId: opened.task.id }
    const click = unwrap(await service.action({ ...request, action: { type: 'click', x: 20, y: 30 } }))
    expect(click.approvalRequired).toBe(false)
    const typed = unwrap(await service.action({ ...request, action: { type: 'type', text: 'hello' } }))
    expect(typed.approvalRequired).toBe(false)
    expect(unwrap(await service.list({ threadId: 'a' })).grant?.source).toBe('settings')
  })

  it('also answers the thread’s requests already waiting when it is given, and no other thread’s', async () => {
    const { service, target } = await browserFixture()
    const owner = { threadId: target.threadId, workspaceId: target.workspaceId }
    const other = { threadId: 'b', workspaceId: unwrap(await service.list({ threadId: 'b' })).workspace.workspaceId }
    const first = unwrap(await service.agentOpen({ ...owner, url: 'http://localhost:4555/', description: 'Check the app' }))
    const second = unwrap(await service.agentOpen({ ...owner, url: 'http://localhost:4600/', description: 'Check the settings page' }))
    const elsewhere = unwrap(await service.agentOpen({ ...other, url: 'http://localhost:4700/', description: 'Another check' }))
    const settled = service.waitForAction(second.task.id, second.task.pendingAction!.id)
    unwrap(await service.answerAction({ ...owner, pageId: first.task.pageId, taskId: first.task.id, actionId: first.task.pendingAction!.id, allow: true, forThread: true }))
    const answered = await settled
    expect(answered?.pendingAction).toBeNull()
    expect(answered?.steps.at(-1)).toMatchObject({ action: 'navigate', status: 'completed', detail: expect.stringContaining('Not asked: you let this thread use the browser without asking.') })
    expect(unwrap(await service.list({ threadId: 'a' })).pages.find(page => page.id === second.task.pageId)?.sharedOrigin).toBe('http://localhost:4600')
    expect(unwrap(await service.tasks(other)).find(task => task.id === elsewhere.task.id)?.pendingAction?.id).toBe(elsewhere.task.pendingAction!.id)
  })

  it('lets the thread navigate, click and type its shared pages without asking once granted', async () => {
    const { service, target } = await browserFixture()
    const request = await grantThread(service, { threadId: target.threadId, workspaceId: target.workspaceId })
    const view = lastView()
    const moved = unwrap(await service.action({ ...request, action: { type: 'navigate', url: 'http://localhost:4555/settings' } }))
    expect(moved.approvalRequired).toBe(false)
    expect(view.webContents.getURL()).toBe('http://localhost:4555/settings')
    const click = unwrap(await service.action({ ...request, action: { type: 'click', x: 20, y: 30 } }))
    expect(click.approvalRequired).toBe(false)
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed' }))
    const typing = unwrap(await service.action({ ...request, action: { type: 'type', text: 'hello' } }))
    expect(typing.approvalRequired).toBe(false)
  })

  it('a waiting action whose page changed still does not run once granted', async () => {
    const { service, target } = await browserFixture()
    const owner = { threadId: target.threadId, workspaceId: target.workspaceId }
    const opened = unwrap(await service.agentOpen({ ...owner, url: 'http://localhost:4555/', description: 'Check the app' }))
    const request = { ...owner, pageId: opened.task.pageId, taskId: opened.task.id }
    const view = lastView()
    view.webContents.emit('did-start-navigation', {}, 'http://localhost:4555/moved', false, true)
    await expect(service.answerAction({ ...request, actionId: opened.task.pendingAction!.id, allow: true, forThread: true })).resolves.toMatchObject({ ok: false, error: { code: 'blocked' } })
  })

  it('revokes sharing when a granted navigation leaves the origin, as any navigation does', async () => {
    const { service, target } = await browserFixture()
    const request = await grantThread(service, { threadId: target.threadId, workspaceId: target.workspaceId })
    unwrap(await service.action({ ...request, action: { type: 'navigate', url: 'https://example.com/' } }))
    expect(unwrap(await service.list({ threadId: 'a' })).pages.find(page => page.id === request.pageId)?.sharedOrigin).toBeNull()
    expect(await service.action({ ...request, action: { type: 'navigate', url: 'https://example.com/next' } })).toMatchObject({ ok: false, error: { code: 'blocked' } })
  })

  it('reaches no other thread and is never made by a denial', async () => {
    const { service, target } = await browserFixture()
    const other = { threadId: 'b', workspaceId: unwrap(await service.list({ threadId: 'b' })).workspace.workspaceId }
    const opened = unwrap(await service.agentOpen({ ...other, url: 'http://localhost:4555/', description: 'Check the app' }))
    const request = { ...other, pageId: opened.task.pageId, taskId: opened.task.id }
    expect(await service.answerAction({ ...request, actionId: opened.task.pendingAction!.id, allow: false, forThread: true })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    unwrap(await service.answerAction({ ...request, actionId: opened.task.pendingAction!.id, allow: true }))
    expect(unwrap(await service.list({ threadId: 'b' })).grant).toBeNull()
    await grantThread(service, { threadId: target.threadId, workspaceId: target.workspaceId })
    expect(unwrap(await service.agentOpen({ ...other, url: 'http://localhost:4700/', description: 'Another check' })).approvalRequired).toBe(true)
  })

  it('ends at Stop, and the thread asks again', async () => {
    const { service, target, emit } = await browserFixture()
    const owner = { threadId: target.threadId, workspaceId: target.workspaceId }
    await grantThread(service, owner)
    unwrap(await service.stopGrant(owner))
    expect(emit).toHaveBeenLastCalledWith({ type: 'browser-grant', threadId: 'a', grant: null })
    expect(unwrap(await service.list({ threadId: 'a' })).grant).toBeNull()
    expect(unwrap(await service.agentOpen({ ...owner, url: 'http://localhost:4600/', description: 'Check again' })).approvalRequired).toBe(true)
  })

  it('turning the setting off ends the settings grant but keeps a grant the user gave by answering', async () => {
    let on = false
    const { service } = await browserFixture(false, new Set(), () => on)
    // Thread b gets an explicit user grant while the setting is off.
    const userGranted = { threadId: 'b', workspaceId: unwrap(await service.list({ threadId: 'b' })).workspace.workspaceId }
    await grantThread(service, userGranted)
    on = true
    expect(unwrap(await service.list({ threadId: 'a' })).grant?.source).toBe('settings')
    expect(unwrap(await service.list(userGranted)).grant?.source).toBe('user')
    on = false
    expect(unwrap(await service.list({ threadId: 'a' })).grant).toBeNull()
    expect(unwrap(await service.list(userGranted)).grant?.source).toBe('user')
  })

  it('ends with its thread and with the browser session', async () => {
    const gone = new Set<string>()
    const { service, target, emit } = await browserFixture(false, gone)
    const owner = { threadId: target.threadId, workspaceId: target.workspaceId }
    await grantThread(service, owner)
    gone.add('a')
    expect(await service.list({ threadId: 'a' })).toMatchObject({ ok: false, error: { code: 'thread-unavailable' } })
    expect(emit).toHaveBeenLastCalledWith({ type: 'browser-grant', threadId: 'a', grant: null })
    gone.delete('a')
    expect(unwrap(await service.list({ threadId: 'a' })).grant).toBeNull()
    await grantThread(service, owner)
    service.dispose()
    const restarted = (await browserFixture()).service
    expect(unwrap(await restarted.list({ threadId: 'a' })).grant).toBeNull()
  })
})
