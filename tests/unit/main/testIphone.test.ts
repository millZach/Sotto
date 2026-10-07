// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { WebContentsView, session, type BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { BrowserService } from '../../../src/main/tools/browser'
import { BrowserAutomation } from '../../../src/main/tools/browserAutomation'
import { FilesService } from '../../../src/main/files/service'
import { TEST_IPHONE } from '../../../src/shared/browser'
import type { ToolsResult } from '../../../src/shared/tools'

// Pages are Electron views; this is the same fixture as browserTools.test.ts, extended with what makes
// a page a phone: user agent, zoom, inserted CSS and the view's own rounded corners (ADR-0045).
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    url = ''; destroyed = false
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    debugger = Object.assign(new EventEmitter(), { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async (method: string) => method === 'Page.getLayoutMetrics' ? { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 393, clientHeight: 852 } } : method === 'Page.captureScreenshot' ? { data: 'YQ==' } : method === 'Accessibility.getFullAXTree' ? { nodes: [] } : method === 'DOM.getNodeForLocation' ? { backendNodeId: 7 } : method === 'DOM.describeNode' ? { node: { backendNodeId: 7, nodeName: 'INPUT', attributes: ['aria-label', 'Name', 'type', 'text'] } } : method === 'Runtime.evaluate' ? { result: { objectId: 'input-1', value: [] } } : {}) })
    capturePage = vi.fn(async () => ({ isEmpty: () => false, getSize: () => ({ width: 393, height: 852 }), toDataURL: () => 'data:image/png;base64,YQ==', resize: () => ({ toJPEG: () => Buffer.from('thumbnail') }) }))
    getBackgroundThrottling = vi.fn(() => true)
    setBackgroundThrottling = vi.fn()
    setUserAgent = vi.fn()
    setZoomFactor = vi.fn()
    insertCSS = vi.fn(async () => undefined)
    getURL() { return this.url }
    isDestroyed() { return this.destroyed }
    loadURL(url: string) { this.url = url; return Promise.resolve() }
    setWindowOpenHandler = vi.fn()
    close() { this.destroyed = true; this.emit('destroyed') }
  }
  class IsolatedSession extends EventEmitter {
    setSpellCheckerDictionaryDownloadURL = vi.fn()
    setSpellCheckerEnabled = vi.fn()
    setPermissionRequestHandler = vi.fn(); setPermissionCheckHandler = vi.fn(); setDevicePermissionHandler = vi.fn()
    webRequest = { onBeforeRequest: vi.fn() }
    closeAllConnections = vi.fn().mockResolvedValue(undefined)
  }
  const makeImage = (buffer: Buffer, width = 393, height = 852) => ({
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
  return {
    BaseWindow: vi.fn(CaptureWindow),
    screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    nativeImage: { createFromDataURL: vi.fn((data: string) => makeImage(Buffer.from(data.split(',')[1]!, 'base64'))), createFromBuffer: vi.fn((buffer: Buffer) => makeImage(buffer)) },
    WebContentsView: vi.fn(class { webContents = new Contents(); bounds = { x: 0, y: 0, width: 1280, height: 800 }; setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = bounds }); getBounds = () => this.bounds; setBorderRadius = vi.fn() }),
    session: { fromPartition: vi.fn(() => new IsolatedSession()) },
  }
})

const unwrap = <T>(result: ToolsResult<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.clearAllMocks() })

async function fixture(byDefault: () => boolean = () => false) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-test-iphone-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory: directory }), copyPath: vi.fn(), reveal: vi.fn() })
  const emit = vi.fn(), attached = new Set<WebContentsView>()
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getContentSize: () => [1200, 800],
    webContents: Object.assign(new EventEmitter(), { getZoomFactor: () => 1 }),
    contentView: { addChildView: (view: WebContentsView) => attached.add(view), removeChildView: (view: WebContentsView) => attached.delete(view) },
  }) as unknown as BrowserWindow
  const service = new BrowserService({ files, getWindow: () => window, emit, openExternal: vi.fn(), destination: async () => 'embedded', byDefault })
  cleanup.push(async () => service.dispose())
  return { service, emit, attached }
}

const lastView = (): WebContentsView => vi.mocked(WebContentsView).mock.results.at(-1)!.value as WebContentsView

describe('the test iPhone page (ADR-0045)', () => {
  it('opens at the iPhone\'s size with an iOS user agent and its own session, apart from an ordinary page and per thread', async () => {
    const { service } = await fixture()
    const ownerA = unwrap(await service.list({ threadId: 'a' })).workspace
    unwrap(await service.create({ threadId: 'a', workspaceId: ownerA.workspaceId, url: 'http://localhost/ordinary' }))
    const ordinaryView = lastView()
    expect(ordinaryView.getBounds()).toEqual({ x: 0, y: 0, width: 1280, height: 800 })

    const phoneA = unwrap(await service.phoneOpen({ threadId: 'a', workspaceId: ownerA.workspaceId, url: 'http://localhost/phone', description: 'Check it on a phone' }))
    const phoneViewA = lastView()
    expect(phoneViewA.getBounds()).toEqual({ x: 0, y: 0, width: TEST_IPHONE.width, height: TEST_IPHONE.height })
    expect(phoneViewA.webContents.setUserAgent).toHaveBeenCalledWith(TEST_IPHONE.userAgent)
    expect(unwrap(await service.list({ threadId: 'a' })).pages.find(page => page.id === phoneA.task.pageId)?.device).toBe('iphone')

    const partitions = vi.mocked(session.fromPartition).mock.calls.map(call => call[0] as string)
    expect(partitions[0]).toMatch(/^sotto-browser-/)
    expect(partitions[1]).toMatch(/^sotto-phone-/)
    expect(partitions[0]).not.toBe(partitions[1])

    const ownerB = unwrap(await service.list({ threadId: 'b' })).workspace
    vi.mocked(session.fromPartition).mockClear()
    unwrap(await service.phoneOpen({ threadId: 'b', workspaceId: ownerB.workspaceId, url: 'http://localhost/phone', description: 'Check it on a phone' }))
    expect(vi.mocked(session.fromPartition).mock.calls[0]![0]).toMatch(/^sotto-phone-/)
    expect(vi.mocked(session.fromPartition).mock.calls[0]![0]).not.toBe(partitions[1])
  })

  it('refuses a second test iPhone for the same thread', async () => {
    const { service } = await fixture()
    const owner = unwrap(await service.list({ threadId: 'a' })).workspace
    unwrap(await service.phoneOpen({ threadId: 'a', workspaceId: owner.workspaceId, url: 'http://localhost/phone', description: 'Check it' }))
    expect(await service.create({ threadId: 'a', workspaceId: owner.workspaceId, url: 'http://localhost/phone-2', device: 'iphone' })).toMatchObject({ ok: false, error: { code: 'busy' } })
  })

  it('mounts an ordinary page and the phone at once, and replacing the pane leaves the phone attached', async () => {
    const { service, attached } = await fixture()
    const owner = unwrap(await service.list({ threadId: 'a' })).workspace
    const target = { threadId: 'a', workspaceId: owner.workspaceId }
    const first = unwrap(await service.create({ ...target, url: 'http://localhost/first' }))
    const firstView = lastView()
    const phone = unwrap(await service.phoneOpen({ ...target, url: 'http://localhost/phone', description: 'Check it' }))
    const phoneView = lastView()
    unwrap(await service.mount({ ...target, pageId: first.id, bounds: { x: 0, y: 0, width: 400, height: 800 } }))
    unwrap(await service.mount({ ...target, pageId: phone.task.pageId, bounds: { x: 400, y: 0, width: 200, height: 400 } }))
    expect(attached.has(firstView)).toBe(true)
    expect(attached.has(phoneView)).toBe(true)

    const second = unwrap(await service.create({ ...target, url: 'http://localhost/second' }))
    const secondView = lastView()
    unwrap(await service.mount({ ...target, pageId: second.id, bounds: { x: 0, y: 0, width: 400, height: 800 } }))
    expect(attached.has(firstView)).toBe(false)
    expect(attached.has(secondView)).toBe(true)
    expect(attached.has(phoneView)).toBe(true)
  })

  it('fits the phone to the player\'s width and rounds its corners, and reapplies zoom and the scrollbar CSS on every document', async () => {
    const { service } = await fixture()
    const owner = unwrap(await service.list({ threadId: 'a' })).workspace
    const target = { threadId: 'a', workspaceId: owner.workspaceId }
    const phone = unwrap(await service.phoneOpen({ ...target, url: 'http://localhost/phone', description: 'Check it' }))
    const view = lastView()
    unwrap(await service.mount({ ...target, pageId: phone.task.pageId, bounds: { x: 0, y: 0, width: 786, height: 1200 } }))
    expect(view.webContents.setZoomFactor).toHaveBeenCalledWith(2)
    expect(view.setBorderRadius).toHaveBeenCalledWith(Math.round(786 * 0.12))

    // Below the clamp, the zoom never drops under a quarter size.
    vi.mocked(view.webContents.setZoomFactor).mockClear()
    unwrap(await service.mount({ ...target, pageId: phone.task.pageId, bounds: { x: 0, y: 0, width: 50, height: 100 } }))
    expect(view.webContents.setZoomFactor).toHaveBeenCalledWith(0.25)

    vi.mocked(view.webContents.setZoomFactor).mockClear()
    vi.mocked(view.webContents.insertCSS).mockClear()
    view.webContents.emit('dom-ready')
    expect(view.webContents.setZoomFactor).toHaveBeenCalledWith(0.25)
    expect(view.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('scrollbar'))

    vi.mocked(view.webContents.setZoomFactor).mockClear()
    view.webContents.emit('did-navigate')
    expect(view.webContents.setZoomFactor).toHaveBeenCalledWith(0.25)
  })

  it('turns on touch emulation for the test iPhone but never for an ordinary page', async () => {
    const { service } = await fixture(() => true)
    const owner = unwrap(await service.list({ threadId: 'a' })).workspace
    const target = { threadId: 'a', workspaceId: owner.workspaceId }
    const ordinary = unwrap(await service.create({ ...target, url: 'http://localhost/ordinary' }))
    const ordinaryView = lastView()
    unwrap(await service.share({ ...target, pageId: ordinary.id, enabled: true }))
    const task = unwrap(await service.startTask({ ...target, pageId: ordinary.id, description: 'Check it' }))
    unwrap(await service.action({ ...target, pageId: ordinary.id, taskId: task.id, action: { type: 'inspect' } }))
    expect(ordinaryView.webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', expect.anything())

    unwrap(await service.phoneOpen({ ...target, url: 'http://localhost/phone', description: 'Check it on a phone' }))
    const phoneView = lastView()
    expect(phoneView.webContents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    expect(phoneView.webContents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' })
  })

  it('refuses a viewport change on the test iPhone, directly and through browser_action', async () => {
    const { service } = await fixture(() => true)
    const owner = unwrap(await service.list({ threadId: 'a' })).workspace
    const target = { threadId: 'a', workspaceId: owner.workspaceId }
    const phone = unwrap(await service.phoneOpen({ ...target, url: 'http://localhost/phone', description: 'Check it' }))
    expect(phone.approvalRequired).toBe(false)
    expect(await service.viewport({ ...target, pageId: phone.task.pageId, width: 800, height: 600 })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    expect(await service.action({ ...target, pageId: phone.task.pageId, taskId: phone.task.id, action: { type: 'viewport', width: 800, height: 600 } })).toMatchObject({ ok: false, error: { code: 'blocked' } })
  })

  it('replaces an idle test iPhone and refuses a new one while its task is still working', async () => {
    const { service, emit } = await fixture(() => true)
    const owner = unwrap(await service.list({ threadId: 'a' })).workspace
    const target = { threadId: 'a', workspaceId: owner.workspaceId }
    const first = unwrap(await service.phoneOpen({ ...target, url: 'http://localhost/first', description: 'Check first' }))
    expect(await service.phoneOpen({ ...target, url: 'http://localhost/second', description: 'Check second' })).toMatchObject({ ok: false, error: { code: 'busy' } })

    unwrap(await service.finishTask({ ...target, pageId: first.task.pageId, taskId: first.task.id, status: 'completed', summary: 'Checked', unchecked: [] }))
    emit.mockClear()
    const second = unwrap(await service.phoneOpen({ ...target, url: 'http://localhost/second', description: 'Check second' }))
    expect(emit).toHaveBeenCalledWith({ type: 'closed', threadId: 'a', workspaceId: owner.workspaceId, pageId: first.task.pageId })
    expect(second.task.pageId).not.toBe(first.task.pageId)
    expect(unwrap(await service.list({ threadId: 'a' })).pages.find(page => page.id === first.task.pageId)).toBeUndefined()
  })

  describe('tap, swipe and key', () => {
    it('run tap and key at once when the thread uses the browser without asking', async () => {
      const { service } = await fixture(() => true)
      const owner = unwrap(await service.list({ threadId: 'a' })).workspace
      const target = { threadId: 'a', workspaceId: owner.workspaceId }
      const phone = unwrap(await service.phoneOpen({ ...target, url: 'http://localhost/phone', description: 'Check it' }))
      const view = lastView()
      const tap = unwrap(await service.action({ ...target, pageId: phone.task.pageId, taskId: phone.task.id, action: { type: 'tap', x: 20, y: 40 } }))
      expect(tap.approvalRequired).toBe(false)
      expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 20, y: 40 }] })
      expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

      const key = unwrap(await service.action({ ...target, pageId: phone.task.pageId, taskId: phone.task.id, action: { type: 'key', key: 'Enter' } }))
      expect(key.approvalRequired).toBe(false)
      expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyDown', text: '\r' }))
    })

    it('wait for the user before a tap or key press when the thread does not use the browser without asking', async () => {
      const { service } = await fixture(() => false)
      const owner = unwrap(await service.list({ threadId: 'a' })).workspace
      const target = { threadId: 'a', workspaceId: owner.workspaceId }
      const phone = unwrap(await service.phoneOpen({ ...target, url: 'http://localhost/phone', description: 'Check it' }))
      unwrap(await service.answerAction({ ...target, pageId: phone.task.pageId, taskId: phone.task.id, actionId: phone.task.pendingAction!.id, allow: true }))

      const tap = unwrap(await service.action({ ...target, pageId: phone.task.pageId, taskId: phone.task.id, action: { type: 'tap', x: 20, y: 40 } }))
      expect(tap.approvalRequired).toBe(true)
      expect(tap.task.pendingAction?.description).toBe('Tap at 20, 40 on the test iPhone at http://localhost/phone')
      unwrap(await service.answerAction({ ...target, pageId: phone.task.pageId, taskId: phone.task.id, actionId: tap.task.pendingAction!.id, allow: false }))

      const key = unwrap(await service.action({ ...target, pageId: phone.task.pageId, taskId: phone.task.id, action: { type: 'key', key: 'Backspace' } }))
      expect(key.approvalRequired).toBe(true)
      expect(key.task.pendingAction?.description).toBe('Press Backspace on the test iPhone at http://localhost/phone')
    })

    it('never asks before a swipe, granted or not', async () => {
      for (const byDefault of [true, false]) {
        const { service } = await fixture(() => byDefault)
        const owner = unwrap(await service.list({ threadId: 'a' })).workspace
        const target = { threadId: 'a', workspaceId: owner.workspaceId }
        const phone = unwrap(await service.phoneOpen({ ...target, url: 'http://localhost/phone', description: 'Check it' }))
        if (!byDefault) unwrap(await service.answerAction({ ...target, pageId: phone.task.pageId, taskId: phone.task.id, actionId: phone.task.pendingAction!.id, allow: true }))
        const swipe = unwrap(await service.action({ ...target, pageId: phone.task.pageId, taskId: phone.task.id, action: { type: 'swipe', x: 10, y: 500, toX: 10, toY: 100 } }))
        expect(swipe.approvalRequired).toBe(false)
      }
    })

    it('refuses a swipe too short to be anything but a tap, so it cannot tap without asking', async () => {
      const { service } = await fixture(() => false)
      const owner = unwrap(await service.list({ threadId: 'a' })).workspace
      const target = { threadId: 'a', workspaceId: owner.workspaceId }
      const phone = unwrap(await service.phoneOpen({ ...target, url: 'http://localhost/phone', description: 'Check it' }))
      unwrap(await service.answerAction({ ...target, pageId: phone.task.pageId, taskId: phone.task.id, actionId: phone.task.pendingAction!.id, allow: true }))
      for (const end of [{ toX: 100, toY: 200 }, { toX: 110, toY: 210 }]) {
        expect(await service.action({ ...target, pageId: phone.task.pageId, taskId: phone.task.id, action: { type: 'swipe', x: 100, y: 200, ...end } })).toMatchObject({ ok: false, error: { code: 'blocked' } })
      }
    })
  })
})

function fakeContents(): WebContents {
  const debug = Object.assign(new EventEmitter(), { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) })
  return { debugger: debug, isDestroyed: () => false, getURL: () => 'http://localhost/phone' } as unknown as WebContents
}

describe('BrowserAutomation.input on a touch-enabled page (ADR-0045)', () => {
  it('sends a touch start, ten touch moves and a touch end for a swipe', async () => {
    const contents = fakeContents()
    const automation = new BrowserAutomation(contents, undefined, true)
    await automation.input({ type: 'swipe', x: 0, y: 500, toX: 0, toY: 100 }, () => undefined)
    const types = vi.mocked(contents.debugger.sendCommand).mock.calls.filter(call => call[0] === 'Input.dispatchTouchEvent').map(call => (call[1] as { type: string }).type)
    expect(types).toEqual(['touchStart', ...Array<string>(10).fill('touchMove'), 'touchEnd'])
  })

  it('still sends the touch end when a move fails partway through a swipe', async () => {
    const contents = fakeContents()
    let moves = 0
    vi.mocked(contents.debugger.sendCommand).mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Input.dispatchTouchEvent' && (params as { type: string })?.type === 'touchMove') {
        moves++
        if (moves === 3) throw new Error('dropped')
      }
      return {}
    })
    const automation = new BrowserAutomation(contents, undefined, true)
    await expect(automation.input({ type: 'swipe', x: 0, y: 0, toX: 0, toY: 300 }, () => undefined)).rejects.toThrow('dropped')
    const types = vi.mocked(contents.debugger.sendCommand).mock.calls.filter(call => call[0] === 'Input.dispatchTouchEvent').map(call => (call[1] as { type: string }).type)
    expect(moves).toBe(3)
    expect(types.at(-1)).toBe('touchEnd')
  })

  it('types Enter\'s carriage return but sends Backspace as a bare key press', async () => {
    const contents = fakeContents()
    const automation = new BrowserAutomation(contents, undefined, true)
    await automation.input({ type: 'key', key: 'Enter' }, () => undefined)
    const enterCalls = vi.mocked(contents.debugger.sendCommand).mock.calls.filter(call => call[0] === 'Input.dispatchKeyEvent')
    expect(enterCalls[0]![1]).toMatchObject({ type: 'keyDown', text: '\r', unmodifiedText: '\r' })
    expect(enterCalls[1]![1]).toMatchObject({ type: 'keyUp' })

    vi.mocked(contents.debugger.sendCommand).mockClear()
    await automation.input({ type: 'key', key: 'Backspace' }, () => undefined)
    const backspaceCalls = vi.mocked(contents.debugger.sendCommand).mock.calls.filter(call => call[0] === 'Input.dispatchKeyEvent')
    expect(backspaceCalls[0]![1]).toMatchObject({ type: 'rawKeyDown' })
    expect(backspaceCalls[0]![1]).not.toHaveProperty('text')
  })
})
