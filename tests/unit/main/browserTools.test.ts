// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { BaseWindow, WebContentsView, type BrowserWindow } from 'electron'
import { BrowserService } from '../../../src/main/tools/browser'
import { BROWSER_COMMAND_DEADLINE_MS } from '../../../src/main/tools/browserAutomation'
import { FilesService } from '../../../src/main/files/service'
import type { ToolsResult } from '../../../src/shared/tools'
import { deferred } from '../../fixtures/deferred'

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
    setWindowOpenHandler = vi.fn(); focus = vi.fn()
    close() { this.destroyed = true; this.emit('destroyed') }
  }
  class IsolatedSession extends EventEmitter {
    setSpellCheckerDictionaryDownloadURL = vi.fn()
    setSpellCheckerEnabled = vi.fn()
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
    vi.spyOn(files, 'resolveWorkspace').mockImplementationOnce(() => { const pending = deferred<Awaited<ReturnType<FilesService['resolveWorkspace']>>>(); finishValidation = pending.resolve; return pending.promise })
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
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: vi.fn(() => true), isMinimized: vi.fn(() => false), getContentSize: () => [1200, 800], webContents: Object.assign(new EventEmitter(), { getZoomFactor: () => 1, focus: vi.fn() }), contentView: { addChildView: (view: WebContentsView) => attached.add(view), removeChildView: (view: WebContentsView) => attached.delete(view) } }) as unknown as BrowserWindow
  const service = new BrowserService({ files, getWindow: () => withWindow ? window : null, emit, openExternal: vi.fn(), destination: async () => 'embedded', byDefault, pointAtSomething: true })
  cleanup.push(async () => service.dispose())
  const owner = unwrap(await service.list({ threadId: 'a' })).workspace
  const target = { threadId: 'a', workspaceId: owner.workspaceId }
  const page = unwrap(await service.create({ ...target, url: 'http://localhost:4321/' }))
  const view = vi.mocked(WebContentsView).mock.results.at(-1)!.value as WebContentsView
  return { service, target: { ...target, pageId: page.id }, view, emit, attached, window, files }
}

describe('browser agent boundaries', () => {
  it('blocks dictionary downloads on an isolated browser session without disabling spellcheck', async () => {
    await browserFixture()
    const options = vi.mocked(WebContentsView).mock.calls.at(-1)![0]!
    const isolated = options.webPreferences!.session!
    expect(isolated.setSpellCheckerDictionaryDownloadURL).toHaveBeenCalledWith('data:,')
    expect(isolated.setSpellCheckerEnabled).not.toHaveBeenCalled()
  })
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
    const captureGate = deferred<{ data: string }>()
    let release!: (value: { data: string }) => void
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => {
      if (args[0] === 'Page.captureScreenshot') { release = captureGate.resolve; return captureGate.promise }
      return original(...args)
    })
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
  it('ends sharing at a redirect to another site without a grant, and Share then shares the site reached', async () => {
    const { service, target, view } = await browserFixture()
    unwrap(await service.share({ ...target, enabled: true }))
    view.webContents.emit('did-start-navigation', {}, 'http://localhost:4321/upload', false, true)
    ;(view.webContents as unknown as { url: string }).url = 'https://accounts.example.com/signin'
    view.webContents.emit('did-redirect-navigation', {}, 'https://accounts.example.com/signin', false, true)
    expect(unwrap(await service.list({ threadId: 'a' })).pages.find(item => item.id === target.pageId)).toMatchObject({ url: 'https://accounts.example.com/signin', sharedOrigin: null })
    expect(unwrap(await service.share({ ...target, enabled: true })).sharedOrigin).toBe('https://accounts.example.com')
    expect(unwrap(await service.startTask({ ...target, description: 'Sign in' })).status).toBe('working')
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
    const captureGate = deferred<{ data: string }>()
    let release!: (value: { data: string }) => void
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => {
      if (args[0] === 'Page.captureScreenshot') { release = captureGate.resolve; return captureGate.promise }
      return original(...args)
    })
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

describe('browser actions that the page cannot finish', () => {
  const parked = (view: WebContentsView): boolean => vi.mocked(BaseWindow).mock.results.some(result => {
    const window = result.value as { children: Set<unknown>; isDestroyed(): boolean }
    return window.children.has(view) && !window.isDestroyed()
  })
  /** With the browser grant on, as it is by default, so a tap runs rather than asking (ADR-0029). */
  async function sharedTask(withWindow = false) {
    const fixture = await browserFixture(withWindow, new Set(), () => true)
    unwrap(await fixture.service.share({ ...fixture.target, enabled: true }))
    const task = unwrap(await fixture.service.startTask({ ...fixture.target, description: 'Scroll the notes' }))
    return { ...fixture, request: { ...fixture.target, taskId: task.id } }
  }
  afterEach(() => { vi.useRealTimers() })

  it.each([
    { type: 'scroll', x: 300, y: 300, deltaX: 0, deltaY: 400 },
    { type: 'tap', x: 50, y: 30 },
  ] as const)('lends a page that is not on screen a surface for $type, which Chromium answers only once the page draws', async action => {
    const { service, request, view, attached } = await sharedTask(true)
    expect(attached.has(view)).toBe(false)
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    // Chromium answers wheel and touch only after a frame; a page with nowhere to draw makes none (the 300-second hangs).
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => {
      if ((args[0] === 'Input.dispatchMouseEvent' || args[0] === 'Input.dispatchTouchEvent') && !parked(view)) throw new Error('No frame to answer from.')
      return original(...args)
    })
    const result = await service.action({ ...request, action })
    expect(result).toMatchObject({ ok: true, value: { task: { steps: [{ action: action.type, status: 'completed' }] } } })
    expect(parked(view)).toBe(false)
  })

  it('fails a command the page never answers in words, and frees the page for the next action', async () => {
    const { service, request, view } = await sharedTask()
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    const dispatched = deferred<void>()
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => {
      if (args[0] !== 'Input.dispatchMouseEvent' || args[1]?.type !== 'mouseWheel' || vi.mocked(view.webContents.debugger.detach).mock.calls.length > 0) return original(...args)
      dispatched.resolve()
      return new Promise(() => undefined)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const hung = service.action({ ...request, action: { type: 'scroll', x: 300, y: 300, deltaX: 0, deltaY: 400 } })
    await dispatched.promise
    await vi.advanceTimersByTimeAsync(BROWSER_COMMAND_DEADLINE_MS)
    expect(await hung).toMatchObject({ ok: false, error: { code: 'unavailable', message: 'The page did not answer in time. Inspect it before trying again.' } })
    expect(view.webContents.debugger.detach).toHaveBeenCalled()
    vi.useRealTimers()
    // Before, the page stayed "still running" and the service kept the hung call's place until the page was shown.
    expect(await service.action({ ...request, action: { type: 'scroll', x: 300, y: 300, deltaX: 0, deltaY: 400 } })).toMatchObject({ ok: true })
  })

  it('keeps the agent\'s viewport through the fresh attachment a deadline leaves behind', async () => {
    const { service, request, view } = await sharedTask()
    unwrap(await service.action({ ...request, action: { type: 'viewport', width: 820, height: 560 } }))
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    const dispatched = deferred<void>()
    let hung = false
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => {
      if (args[0] === 'Input.dispatchMouseEvent' && args[1]?.type === 'mouseWheel' && !hung) { hung = true; dispatched.resolve(); return new Promise(() => undefined) }
      return original(...args)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const scrolled = service.action({ ...request, action: { type: 'scroll', x: 300, y: 300, deltaX: 0, deltaY: 400 } })
    await dispatched.promise
    await vi.advanceTimersByTimeAsync(BROWSER_COMMAND_DEADLINE_MS)
    expect(await scrolled).toMatchObject({ ok: false })
    vi.useRealTimers()
    // Detaching drops Chromium's emulation; the next attachment puts the page back at the size Sotto reports.
    vi.mocked(view.webContents.debugger.sendCommand).mockClear()
    unwrap(await service.action({ ...request, action: { type: 'inspect' } }))
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', { width: 820, height: 560, deviceScaleFactor: 1, mobile: false })
    expect(unwrap(await service.list({ threadId: request.threadId })).pages[0]?.viewport).toEqual({ width: 820, height: 560 })
  })

  it('tries the debugger setup again after it failed once', async () => {
    const { service, target, view } = await browserFixture()
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    let refused = 0
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => {
      if (args[0] === 'Network.enable' && refused++ === 0) throw new Error('Inspected target navigated or closed')
      return original(...args)
    })
    // Sharing starts observing the page, and that first setup fails while the page is moving.
    unwrap(await service.share({ ...target, enabled: true }))
    const task = unwrap(await service.startTask({ ...target, description: 'Read the page' }))
    expect(await service.action({ ...target, taskId: task.id, action: { type: 'inspect' } })).toMatchObject({ ok: true })
    expect(refused).toBe(2)
  })

  it('does not let a screenshot that gave up cut into the next action', async () => {
    const { service, request, view } = await sharedTask()
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    const captured = deferred<void>(), reading = deferred<void>(), tree = deferred<unknown>()
    let captures = 0
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => {
      // Only the first capture hangs; the inspection's own thumbnail afterwards answers.
      if (args[0] === 'Page.captureScreenshot' && !captures++) { captured.resolve(); return new Promise(() => undefined) }
      if (args[0] === 'Accessibility.getFullAXTree') { reading.resolve(); return tree.promise }
      return original(...args)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const shot = service.action({ ...request, action: { type: 'screenshot' } })
    await captured.promise
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await shot).toMatchObject({ ok: false, error: { message: 'The page did not draw in time. Inspect it before trying again.' } })
    const detached = vi.mocked(view.webContents.debugger.detach).mock.calls.length
    const inspecting = service.action({ ...request, action: { type: 'inspect' } })
    await reading.promise
    // Past the abandoned capture command's own deadline, while the inspection is still reading the page.
    await vi.advanceTimersByTimeAsync(BROWSER_COMMAND_DEADLINE_MS - 9_000)
    expect(view.webContents.debugger.detach).toHaveBeenCalledTimes(detached)
    tree.resolve({ nodes: [] })
    expect(await inspecting).toMatchObject({ ok: true })
  })

  it.each([
    { name: 'a swipe', action: { type: 'swipe', x: 300, y: 500, toX: 300, toY: 200 }, hangs: (method: string, params?: Record<string, unknown>) => method === 'Input.dispatchTouchEvent' && params?.type === 'touchMove' },
    { name: 'typing', action: { type: 'type', text: 'hello' }, hangs: (method: string, params?: Record<string, unknown>) => method === 'DOM.describeNode' && params?.objectId !== undefined },
  ] as const)('keeps the deadline\'s words when cleaning up after $name fails too', async ({ action, hangs }) => {
    const { service, request, view } = await sharedTask()
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    let detached = false
    vi.mocked(view.webContents.debugger.detach).mockImplementation(() => { detached = true })
    const waiting = deferred<void>()
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => {
      if (detached) throw new Error('Debugger is not attached.')
      if (hangs(args[0], args[1])) { waiting.resolve(); return new Promise(() => undefined) }
      return original(...args)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = service.action({ ...request, action })
    await waiting.promise
    await vi.advanceTimersByTimeAsync(BROWSER_COMMAND_DEADLINE_MS)
    expect(await result).toMatchObject({ ok: false, error: { code: 'unavailable', message: 'The page did not answer in time. Inspect it before trying again.' } })
  })

  it('says a page that has not drawn yet has not, instead of asking for a refresh', async () => {
    const { service, request, view } = await sharedTask()
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => args[0] === 'Page.getLayoutMetrics' ? {} : original(...args))
    expect(await service.action({ ...request, action: { type: 'screenshot' } })).toMatchObject({ ok: false, error: { code: 'unavailable', message: 'This page has not drawn yet. Wait for it to load, then try again.' } })
  })

  it('says why typing was refused instead of asking for a refresh', async () => {
    const { service, request, view } = await sharedTask()
    const original = vi.mocked(view.webContents.debugger.sendCommand).getMockImplementation()!
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (...args) => args[0] === 'DOM.describeNode' ? { node: { backendNodeId: 7, nodeName: 'DIV', attributes: [] } } : original(...args))
    const result = await service.action({ ...request, action: { type: 'type', text: 'hello' } })
    expect(result).toMatchObject({ ok: false, error: { code: 'blocked' } })
    expect(!result.ok && result.error.message).toMatch(/plain text field/u)
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

  it('keeps a page shared as it moves to another site while granted, and ends sharing there once stopped', async () => {
    const { service, target } = await browserFixture()
    const request = await grantThread(service, { threadId: target.threadId, workspaceId: target.workspaceId })
    unwrap(await service.action({ ...request, action: { type: 'navigate', url: 'https://example.com/' } }))
    expect(unwrap(await service.list({ threadId: 'a' })).pages.find(page => page.id === request.pageId)?.sharedOrigin).toBe('https://example.com')
    expect(unwrap(await service.action({ ...request, action: { type: 'inspect' } })).approvalRequired).toBe(false)
    unwrap(await service.stopGrant({ threadId: request.threadId, workspaceId: request.workspaceId }))
    // Stopping leaves the page shared where it is; leaving that site now ends it, as it does without a grant.
    expect(unwrap(await service.action({ ...request, action: { type: 'navigate', url: 'https://example.com/next' } })).approvalRequired).toBe(true)
    lastView().webContents.emit('did-start-navigation', {}, 'https://elsewhere.example/', false, true)
    expect(unwrap(await service.list({ threadId: 'a' })).pages.find(page => page.id === request.pageId)?.sharedOrigin).toBeNull()
  })

  it('follows a server redirect to the address it reaches, so a shared page can still be read there', async () => {
    const { service, target, view } = await browserFixture(false, new Set(), () => true)
    const contents = view.webContents as unknown as { url: string }
    const task = unwrap(await service.startTask({ ...target, description: 'Upload the video' }))
    view.webContents.emit('did-start-navigation', {}, 'http://localhost:4321/upload', false, true)
    contents.url = 'https://accounts.example.com/signin'
    view.webContents.emit('did-redirect-navigation', {}, 'https://accounts.example.com/signin', false, true)
    view.webContents.emit('did-finish-load')
    const page = unwrap(await service.list({ threadId: 'a' })).pages.find(item => item.id === target.pageId)
    expect(page).toMatchObject({ url: 'https://accounts.example.com/signin', status: 'ready', sharedOrigin: 'https://accounts.example.com' })
    expect(unwrap(await service.action({ ...target, taskId: task.id, action: { type: 'inspect' } })).approvalRequired).toBe(false)
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
  it('shares a page the user opened while the thread uses the browser without asking, until the user makes it private', async () => {
    const { service, target, view } = await browserFixture(false, new Set(), () => true)
    const sharedOrigin = async () => unwrap(await service.list({ threadId: 'a' })).pages.find(page => page.id === target.pageId)?.sharedOrigin
    expect(await sharedOrigin()).toBe('http://localhost:4321')
    const task = unwrap(await service.startTask({ ...target, description: 'Check the form' }))
    expect(unwrap(await service.action({ ...target, taskId: task.id, action: { type: 'inspect' } })).approvalRequired).toBe(false)
    unwrap(await service.share({ ...target, enabled: false }))
    // Private stays private: across a move to another site and when the grant is given again.
    view.webContents.emit('did-start-navigation', {}, 'https://example.com/', false, true)
    service.settingChanged()
    expect(await sharedOrigin()).toBeNull()
    unwrap(await service.share({ ...target, enabled: true }))
    expect(await sharedOrigin()).toBe('https://example.com')
  })

  it('leaves a page an agent asked to open unshared until it is opened, then shares it once the user loads it', async () => {
    let on = false
    const { service, target } = await browserFixture(false, new Set(), () => on)
    const owner = { threadId: target.threadId, workspaceId: target.workspaceId }
    const opened = unwrap(await service.agentOpen({ ...owner, url: 'http://localhost:4555/', description: 'Check the app' }))
    const page = { ...owner, pageId: opened.task.pageId }
    unwrap(await service.answerAction({ ...page, taskId: opened.task.id, actionId: opened.task.pendingAction!.id, allow: false }))
    const sharedOrigin = async () => unwrap(await service.list({ threadId: 'a' })).pages.find(item => item.id === page.pageId)?.sharedOrigin
    on = true
    service.settingChanged()
    // Denied, it was never opened, so the grant does not share it.
    expect(await sharedOrigin()).toBeNull()
    unwrap(await service.navigate({ ...page, url: 'http://localhost:4555/' }))
    expect(await sharedOrigin()).toBe('http://localhost:4555')
    unwrap(await service.share({ ...page, enabled: false }))
    unwrap(await service.reload(page))
    // Reloading a page the user made private keeps it private.
    expect(await sharedOrigin()).toBeNull()
  })

  it('shares the thread’s open pages when the grant is given, not only the pages opened after it', async () => {
    let on = false
    const { service, target, emit } = await browserFixture(false, new Set(), () => on)
    expect(unwrap(await service.list({ threadId: 'a' })).pages[0]?.sharedOrigin).toBeNull()
    on = true; emit.mockClear()
    service.settingChanged()
    expect(emit).toHaveBeenCalledWith({ type: 'page', page: expect.objectContaining({ id: target.pageId, sharedOrigin: 'http://localhost:4321' }) })
    expect(unwrap(await service.startTask({ ...target, description: 'Check the form' })).status).toBe('working')
  })

  it('tells every listed thread when the setting changes, and answers what was waiting when it turns on', async () => {
    let on = false
    const { service, target, emit } = await browserFixture(false, new Set(), () => on)
    const owner = { threadId: target.threadId, workspaceId: target.workspaceId }
    const waiting = unwrap(await service.agentOpen({ ...owner, url: 'http://localhost:4555/', description: 'Check the app' }))
    expect(waiting.approvalRequired).toBe(true)
    unwrap(await service.list({ threadId: 'b' }))
    on = true; emit.mockClear()
    const settled = service.waitForAction(waiting.task.id, waiting.task.pendingAction!.id)
    service.settingChanged()
    for (const threadId of ['a', 'b']) expect(emit).toHaveBeenCalledWith({ type: 'browser-grant', threadId, grant: { grantedAt: expect.any(Number), source: 'settings' } })
    expect((await settled)?.pendingAction).toBeNull()
    on = false; emit.mockClear()
    service.settingChanged()
    for (const threadId of ['a', 'b']) expect(emit).toHaveBeenCalledWith({ type: 'browser-grant', threadId, grant: null })
  })
})

describe('point at something (ADR-0154)', () => {
  const bounds = { x: 400, y: 100, width: 600, height: 500 }
  const color = { r: 10, g: 120, b: 200 }
  /** The overlay's answers for a Sign in button with id `sign-in`, at 10, 20 and 120 by 40; `describeGate` holds a pick's description. */
  function signInPage(view: WebContentsView, describeGate?: Promise<void>): void {
    const command = vi.mocked(view.webContents.debugger.sendCommand)
    const original = command.getMockImplementation()!
    command.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'DOM.describeNode') {
        if (describeGate && params && 'backendNodeId' in params) await describeGate
        return { node: { nodeType: 1, nodeName: 'BUTTON', localName: 'button', backendNodeId: 9, attributes: ['id', 'sign-in', 'class', 'primary'] } }
      }
      if (method === 'Accessibility.getPartialAXTree') return { nodes: [{ role: { value: 'button' }, name: { value: 'Sign in' } }] }
      if (method === 'DOM.getBoxModel') return { model: { border: [10, 20, 130, 20, 130, 60, 10, 60] } }
      if (method === 'DOM.getOuterHTML') return { outerHTML: '<button id="sign-in" class="primary"><span>Sign</span> in</button>' }
      return original(method, params)
    })
  }
  const inspectModes = (view: WebContentsView) => vi.mocked(view.webContents.debugger.sendCommand).mock.calls.filter(([method]) => method === 'Overlay.setInspectMode').map(([, params]) => (params as { mode: string }).mode)
  const overlay = (view: WebContentsView, mode: string) => vi.mocked(view.webContents.debugger.sendCommand).mock.calls.filter(([method, params]) => method === 'Overlay.setInspectMode' && (params as { mode?: string }).mode === mode)
  const pointEvents = (emit: ReturnType<typeof vi.fn>) => emit.mock.calls.map(([event]) => event as { type: string; point?: { state: string; reason?: string } }).filter(event => event.type === 'point')
  const ended = (emit: ReturnType<typeof vi.fn>) => pointEvents(emit).filter(event => event.point?.state === 'ended').map(event => event.point!.reason)
  const picks = (emit: ReturnType<typeof vi.fn>) => pointEvents(emit).filter(event => event.point?.state === 'picked')
  async function pointing(fixture: Awaited<ReturnType<typeof browserFixture>>): Promise<void> {
    unwrap(await fixture.service.mount({ ...fixture.target, bounds }))
    unwrap(await fixture.service.point({ ...fixture.target, on: true, color }))
    await vi.waitFor(() => expect(inspectModes(fixture.view).at(-1)).toBe('searchForNode'))
  }

  it('turns Chromium\'s inspect overlay on in the accent, with its own label, for the page the pane shows, without sharing or a grant, and off again', async () => {
    const { service, target, view } = await browserFixture(true)
    unwrap(await service.mount({ ...target, bounds }))
    expect(unwrap(await service.point({ ...target, on: true, color }))).toEqual({ pointing: true })
    await vi.waitFor(() => expect(overlay(view, 'searchForNode')).toHaveLength(1))
    const config = (overlay(view, 'searchForNode')[0]![1] as { highlightConfig: Record<string, unknown> }).highlightConfig
    // The live highlight is Chromium's tint and its own label, which names the element on the page (item 10).
    expect(config).toMatchObject({ showInfo: true, showAccessibilityInfo: true, borderColor: { ...color }, contentColor: { ...color } })
    // The page gets the keyboard, so Tab moves through its own elements.
    await vi.waitFor(() => expect(view.webContents.focus).toHaveBeenCalled())
    expect(unwrap(await service.list({ threadId: 'a' })).pages[0]!.sharedOrigin).toBeNull()
    expect(unwrap(await service.point({ ...target, on: false }))).toEqual({ pointing: false })
    await vi.waitFor(() => expect(overlay(view, 'none')).toHaveLength(1))
  })

  it('keeps the page on the window when the pane only moves it, so the keyboard Point gave it stays', async () => {
    const fixture = await browserFixture(true)
    await pointing(fixture)
    const removed = vi.spyOn(fixture.attached, 'delete'), added = vi.spyOn(fixture.attached, 'add')
    // The line over the page appears and the page moves down under it.
    unwrap(await fixture.service.mount({ ...fixture.target, bounds: { ...bounds, y: bounds.y + 32, height: bounds.height - 32 } }))
    expect(removed).not.toHaveBeenCalled()
    expect(added).not.toHaveBeenCalled()
    expect(fixture.view.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ y: bounds.y + 32 }))
    expect(inspectModes(fixture.view).at(-1)).toBe('searchForNode')
  })

  it('does nothing on a page nobody shows', async () => {
    const { service, target, view } = await browserFixture(true)
    expect(unwrap(await service.point({ ...target, on: true, color }))).toEqual({ pointing: false })
    unwrap(await service.mount({ ...target, bounds }))
    expect(overlay(view, 'searchForNode')).toHaveLength(0)
  })

  it('refuses a request without the theme\'s accent, so no colour is made up in main (item 7)', async () => {
    const { service, target, view } = await browserFixture(true)
    unwrap(await service.mount({ ...target, bounds }))
    expect(await service.point({ ...target, on: true })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    expect(overlay(view, 'searchForNode')).toHaveLength(0)
  })

  it('is refused while the quiet-browser Owl answer is off (item 4)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-browser-point-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory: directory }), copyPath: vi.fn(), reveal: vi.fn() })
    const service = new BrowserService({ files, getWindow: () => null, emit: vi.fn(), openExternal: vi.fn(), destination: async () => 'embedded', byDefault: () => false })
    cleanup.push(async () => service.dispose())
    const owner = unwrap(await service.list({ threadId: 'a' })).workspace
    const page = unwrap(await service.create({ threadId: 'a', workspaceId: owner.workspaceId, url: 'http://localhost:4321/' }))
    expect(await service.point({ threadId: 'a', workspaceId: owner.workspaceId, pageId: page.id, on: true, color })).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('lets an Off made while an On is still being checked win, so the overlay never comes on after it (item 1)', async () => {
    const { service, target, view, files } = await browserFixture(true)
    unwrap(await service.mount({ ...target, bounds }))
    const real = files.resolveWorkspace.bind(files)
    const checked = deferred<void>()
    vi.spyOn(files, 'resolveWorkspace').mockImplementationOnce(async (...args) => { await checked.promise; return real(...args) })
    const on = service.point({ ...target, on: true, color })
    unwrap(await service.point({ ...target, on: false }))
    checked.resolve()
    expect(unwrap(await on)).toEqual({ pointing: false })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(inspectModes(view)).not.toContain('searchForNode')
  })

  it('makes a start still being checked stale when the window is minimized, and starts nothing on a hidden window', async () => {
    const { service, target, view, files, window } = await browserFixture(true)
    unwrap(await service.mount({ ...target, bounds }))
    const real = files.resolveWorkspace.bind(files)
    const checked = deferred<void>()
    vi.spyOn(files, 'resolveWorkspace').mockImplementationOnce(async (...args) => { await checked.promise; return real(...args) })
    const on = service.point({ ...target, on: true, color })
    window.emit('minimize')
    checked.resolve()
    expect(unwrap(await on)).toEqual({ pointing: false })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(inspectModes(view)).not.toContain('searchForNode')
    // A window already hidden when the start comes in: the overlay never comes on.
    vi.mocked(window.isVisible).mockReturnValue(false)
    unwrap(await service.point({ ...target, on: true, color }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(inspectModes(view)).not.toContain('searchForNode')
  })

  it('makes a start still being checked stale when the page navigates, so Point never comes on for the new page', async () => {
    const { service, target, view, files } = await browserFixture(true)
    unwrap(await service.mount({ ...target, bounds }))
    const real = files.resolveWorkspace.bind(files)
    const checked = deferred<void>()
    vi.spyOn(files, 'resolveWorkspace').mockImplementationOnce(async (...args) => { await checked.promise; return real(...args) })
    const on = service.point({ ...target, on: true, color })
    view.webContents.emit('did-start-navigation', {}, 'http://localhost:4321/next', false, true)
    checked.resolve()
    expect(unwrap(await on)).toEqual({ pointing: false })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(inspectModes(view)).not.toContain('searchForNode')
  })

  it('turns the overlay back off when Off arrives while it is still being turned on (item 1)', async () => {
    const { service, target, view } = await browserFixture(true)
    unwrap(await service.mount({ ...target, bounds }))
    const command = vi.mocked(view.webContents.debugger.sendCommand)
    const original = command.getMockImplementation()!
    const enabling = deferred<void>()
    command.mockImplementation(async (method: string, params?: Record<string, unknown>) => { if (method === 'Network.enable') await enabling.promise; return original(method, params) })
    unwrap(await service.point({ ...target, on: true, color }))
    // Matched by method alone: the deadline-bounded sender passes its parameters, undefined here, as a second argument.
    await vi.waitFor(() => expect(command.mock.calls.some(([method]) => method === 'Network.enable')).toBe(true))
    unwrap(await service.point({ ...target, on: false }))
    enabling.resolve()
    await new Promise(resolve => setTimeout(resolve, 10))
    // Whatever was sent, the last word the overlay had is none.
    expect(inspectModes(view).at(-1)).toBe('none')
  })

  it('names the element under the pointer as data, and a click describes it and takes a picture of the page', async () => {
    const fixture = await browserFixture(true)
    const { target, view, emit, window } = fixture
    signInPage(view)
    await pointing(fixture)
    view.webContents.debugger.emit('message', {}, 'Overlay.nodeHighlightRequested', { nodeId: 4 })
    // Item 8: the tag and the name go as fields, and the window formats them.
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith({ type: 'point', ...target, point: { state: 'hover', tag: 'button', name: 'Sign in' } }))
    view.webContents.debugger.emit('message', {}, 'Overlay.inspectNodeRequested', { backendNodeId: 9 })
    await vi.waitFor(() => expect(picks(emit)).toHaveLength(1))
    const picked = picks(emit)[0]!.point as unknown as { capture: { captureId: string; image: string; url: string; element: unknown }; box: unknown }
    expect(picked.capture.element).toEqual({ tag: 'button', role: 'button', name: 'Sign in', text: 'Sign in', selector: '#sign-in' })
    expect(picked.box).toEqual({ x: 10, y: 20, width: 120, height: 40 })
    expect(picked.capture.image).toMatch(/^data:image\/png/)
    expect(picked.capture.captureId).toMatch(/^[0-9a-f-]{36}$/)
    expect(overlay(view, 'none')).toHaveLength(1)
    expect(window.webContents.focus).toHaveBeenCalled()
    view.webContents.debugger.emit('message', {}, 'Overlay.inspectNodeRequested', { backendNodeId: 9 })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(picks(emit)).toHaveLength(1)
  })

  it('picks the element the keyboard is on with Enter, and the page does not get that Enter (item 5)', async () => {
    const fixture = await browserFixture(true)
    const { view, emit } = fixture
    signInPage(view)
    // Off, Enter is the page's.
    const before = { preventDefault: vi.fn() }
    view.webContents.emit('before-input-event', before, { type: 'keyDown', key: 'Enter' })
    expect(before.preventDefault).not.toHaveBeenCalled()
    await pointing(fixture)
    const enter = { preventDefault: vi.fn() }
    view.webContents.emit('before-input-event', enter, { type: 'keyDown', key: 'Enter' })
    expect(enter.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(picks(emit)).toHaveLength(1))
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({ expression: 'document.activeElement' }))
    expect((picks(emit)[0]!.point as unknown as { capture: { element: { selector: string } } }).capture.element.selector).toBe('#sign-in')
  })

  it('sends no picture when the page is hidden while a pick is being described (item 2)', async () => {
    const fixture = await browserFixture(true)
    const { service, target, view, emit } = fixture
    const describing = deferred<void>()
    signInPage(view, describing.promise)
    await pointing(fixture)
    view.webContents.debugger.emit('message', {}, 'Overlay.inspectNodeRequested', { backendNodeId: 9 })
    await new Promise(resolve => setTimeout(resolve, 5))
    unwrap(await service.mount({ ...target, bounds: null }))
    describing.resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(picks(emit)).toHaveLength(0)
    expect(ended(emit)).toEqual(['hidden'])
  })

  it('ends when the page navigates, is hidden, its window is minimized or hidden, or Escape is pressed in it (item 3)', async () => {
    const fixture = await browserFixture(true)
    const { view, emit, window, service, target } = fixture
    await pointing(fixture)
    view.webContents.emit('did-start-navigation', {}, 'http://localhost:4321/next', false, true)
    expect(ended(emit)).toEqual(['navigated'])
    await pointing(fixture)
    unwrap(await service.mount({ ...target, bounds: null }))
    expect(ended(emit)).toEqual(['navigated', 'hidden'])
    await pointing(fixture)
    window.emit('minimize')
    expect(ended(emit)).toEqual(['navigated', 'hidden', 'hidden'])
    await pointing(fixture)
    window.emit('hide')
    expect(ended(emit)).toEqual(['navigated', 'hidden', 'hidden', 'hidden'])
    await pointing(fixture)
    const keyboard = { preventDefault: vi.fn() }
    view.webContents.emit('before-input-event', keyboard, { type: 'keyDown', key: 'Escape' })
    expect(keyboard.preventDefault).toHaveBeenCalled()
    expect(ended(emit)).toEqual(['navigated', 'hidden', 'hidden', 'hidden', 'escape'])
    const later = { preventDefault: vi.fn() }
    view.webContents.emit('before-input-event', later, { type: 'keyDown', key: 'Escape' })
    expect(later.preventDefault).not.toHaveBeenCalled()
  })
})

describe('a thread file page (ADR-0085, October 27 amendment)', () => {
  const openFrom = async () => {
    const fixture = await browserFixture(false, new Set(), () => true)
    const folder = unwrap(await fixture.service.list({ threadId: 'a' })).workspace.workingDirectory
    await mkdir(join(folder, 'docs', 'prototypes'), { recursive: true })
    await writeFile(join(folder, 'docs', 'prototypes', 'x-prototype.html'), '<!doctype html><title>Picker</title><h1>Picker</h1>')
    await writeFile(join(folder, 'docs', 'prototypes', 'notes.json'), '{}')
    return { ...fixture, folder }
  }
  it('opens an HTML file in the thread\'s folder, named by its file:// URL, at a loopback address Sotto serves', async () => {
    const { service, target, folder } = await openFrom()
    const written = `${pathToFileURL(join(folder, 'docs', 'prototypes', 'x-prototype.html')).href}?variant=A`
    const opened = unwrap(await service.agentOpen({ threadId: target.threadId, workspaceId: target.workspaceId, url: written, description: 'Show the picker prototype' }))
    expect(opened.approvalRequired).toBe(false)
    const view = vi.mocked(WebContentsView).mock.results.at(-1)!.value as WebContentsView
    const url = new URL(view.webContents.getURL())
    expect([url.protocol, url.hostname, url.search]).toEqual(['http:', '127.0.0.1', '?variant=A'])
    expect(url.pathname).toMatch(/^\/page\/[A-Za-z0-9_-]{32}\/x-prototype\.html$/u)
    expect(unwrap(await service.list({ threadId: 'a' })).pages.find(page => page.id === opened.task.pageId)?.url).toBe(url.href)
    const served = await fetch(url)
    expect([served.status, await served.text()]).toEqual([200, expect.stringContaining('<h1>Picker</h1>')])
  })
  it('closes a thread\'s file pages as soon as Sotto no longer lists the thread, before the browser hears of it (review finding)', async () => {
    const gone = new Set<string>()
    const { service, target } = await browserFixture(false, gone, () => true)
    const folder = unwrap(await service.list({ threadId: 'a' })).workspace.workingDirectory
    await writeFile(join(folder, 'prototype.html'), '<h1>Picker</h1>')
    const opened = unwrap(await service.agentOpen({ threadId: target.threadId, workspaceId: target.workspaceId, url: 'prototype.html', description: 'Show it' }))
    const url = unwrap(await service.list({ threadId: 'a' })).pages.find(page => page.id === opened.task.pageId)!.url
    expect((await fetch(url)).status).toBe(200)
    // The thread is removed; no browser call follows, so only the page request itself can notice.
    gone.add('a')
    const closed = await fetch(url)
    expect(closed.status).toBe(404)
    expect(await closed.text()).toContain('This page has closed')
  })
  it('refuses a file outside the thread\'s folder, or one that is not HTML, in plain words and opens nothing', async () => {
    const { service, target: { threadId, workspaceId }, folder } = await openFrom()
    const target = { threadId, workspaceId }
    const outside = await mkdtemp(join(tmpdir(), 'sotto-browser-outside-'))
    cleanup.push(() => rm(outside, { recursive: true, force: true }))
    await writeFile(join(outside, 'elsewhere.html'), 'outside')
    const before = unwrap(await service.list({ threadId: 'a' })).pages.length
    const away = await service.agentOpen({ ...target, url: pathToFileURL(join(outside, 'elsewhere.html')).href, description: 'Show it' })
    expect(away).toMatchObject({ ok: false, error: { code: 'blocked', message: expect.stringMatching(/^Only HTML files inside this thread's folder can open in Sotto's browser\. .*elsewhere\.html is outside it\./u) } })
    const data = await service.agentOpen({ ...target, url: join(folder, 'docs', 'prototypes', 'notes.json'), description: 'Show it' })
    expect(data).toMatchObject({ ok: false, error: { code: 'blocked', message: expect.stringContaining('is not one') } })
    const scheme = await service.phoneOpen({ ...target, url: 'ftp://example.com/page.html', description: 'Show it' })
    expect(scheme).toMatchObject({ ok: false, error: { code: 'invalid-request', message: expect.stringContaining('or an HTML file in this thread\'s folder') } })
    expect(JSON.stringify([away, data, scheme])).not.toContain('Use the tool\'s documented arguments')
    expect(unwrap(await service.list({ threadId: 'a' })).pages.length).toBe(before)
  })
})
