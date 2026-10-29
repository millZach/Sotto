// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserService } from '../../../../src/main/tools/browser'
import { FilesService } from '../../../../src/main/files/service'
import type { BrowserBridge } from '../../../../src/shared/browser'
import type { ToolsResult } from '../../../../src/shared/tools'
import { BrowserStore } from '../../../../src/renderer/src/tools/browserStore'

// Listing pages and reading tasks open no page, so nothing of Electron is reached.
vi.mock('electron', () => ({ BaseWindow: vi.fn(), WebContentsView: vi.fn(), screen: {}, nativeImage: {}, session: {} }))

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.useRealTimers() })

/** Main's real browser and Files services behind a bridge, as the window reaches them. */
async function realMain(): Promise<{ bridge: BrowserBridge; service: BrowserService; inFlight: () => number; most: () => number; asked: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-browser-first-open-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory: directory }), copyPath: vi.fn(), reveal: vi.fn() })
  const service = new BrowserService({ files, getWindow: () => null, emit: vi.fn(), openExternal: vi.fn(), destination: async () => 'external', byDefault: () => false })
  cleanup.push(async () => service.dispose())
  let current = 0, most = 0
  const asked: string[] = []
  const counted = <T>(request: Promise<ToolsResult<T>>): Promise<ToolsResult<T>> => {
    current++; most = Math.max(most, current)
    return request.finally(() => { current-- })
  }
  const bridge = {
    list: request => service.list(request),
    tasks: request => { asked.push(request.threadId); return counted(service.tasks(request)) },
    mount: request => service.mount(request),
    onEvent: () => () => undefined,
  } as Partial<BrowserBridge> as BrowserBridge
  return { bridge, service, inFlight: () => current, most: () => most, asked }
}

describe('Tools > Browser opened while the players catch up on every thread', () => {
  it('lists the thread\'s pages instead of saying the browser is busy', async () => {
    const main = await realMain()
    const store = new BrowserStore()
    // The Browser player and the phone player are always mounted: on start-up they watch every local thread's tasks.
    const threads = Array.from({ length: 24 }, (_, index) => `thread-${index}`)
    store.watchTasks(main.bridge, threads)
    // The user opens Tools > Browser on one of them meanwhile.
    await store.activate(main.bridge, 'thread-3')
    expect(store.thread('thread-3')).toMatchObject({ status: 'ready', error: null })
  })

  it('still reads every thread\'s tasks, one at a time', async () => {
    const main = await realMain()
    const store = new BrowserStore()
    const threads = Array.from({ length: 24 }, (_, index) => `thread-${index}`)
    store.watchTasks(main.bridge, threads)
    await vi.waitFor(() => expect(main.asked).toHaveLength(threads.length))
    await vi.waitFor(() => expect(main.inFlight()).toBe(0))
    expect(main.asked).toEqual(threads)
    expect(main.most()).toBe(1)
  })

  it('asks once more, quietly, when main is busy for a moment', async () => {
    vi.useFakeTimers()
    const main = await realMain()
    const busy = { ok: false as const, error: { code: 'busy' as const, message: 'This tool is busy. Try again shortly.' } }
    const list = vi.fn(main.bridge.list).mockResolvedValueOnce(busy)
    const store = new BrowserStore()
    const opening = store.activate({ ...main.bridge, list }, 'thread-1')
    await vi.runAllTimersAsync()
    await opening
    expect(list).toHaveBeenCalledTimes(2)
    expect(store.thread('thread-1')).toMatchObject({ status: 'ready', error: null })
  })

  it('places the page on a second ask when main was busy for the first', async () => {
    vi.useFakeTimers()
    const main = await realMain()
    const busy = { ok: false as const, error: { code: 'busy' as const, message: 'This tool is busy. Try again shortly.' } }
    const mount = vi.fn(async (): Promise<ToolsResult<void>> => ({ ok: true, value: undefined })).mockResolvedValueOnce(busy)
    const store = new BrowserStore()
    const workspace = { threadId: 'thread-1', projectId: 'p', workingDirectory: '/work', workspaceId: 'w' }
    store.adopt({ id: 'page', workspace, url: 'http://localhost:5173/', title: '', status: 'ready', error: null, canGoBack: false, canGoForward: false, sharedOrigin: null, viewport: null, device: null })
    const bounds = { x: 0, y: 0, width: 600, height: 400 }
    store.mount({ ...main.bridge, mount }, 'thread-1', 'page', bounds)
    await vi.runAllTimersAsync()
    expect(mount.mock.calls).toEqual([[{ threadId: 'thread-1', workspaceId: 'w', pageId: 'page', bounds }], [{ threadId: 'thread-1', workspaceId: 'w', pageId: 'page', bounds }]])
    expect(store.thread('thread-1')?.placementProblem).toBeNull()
  })

  it('says the browser is busy when it still is on the second ask', async () => {
    vi.useFakeTimers()
    const main = await realMain()
    const busy = { ok: false as const, error: { code: 'busy' as const, message: 'This tool is busy. Try again shortly.' } }
    const list = vi.fn(async () => busy)
    const store = new BrowserStore()
    const opening = store.activate({ ...main.bridge, list }, 'thread-1')
    await vi.runAllTimersAsync()
    await opening
    expect(list).toHaveBeenCalledTimes(2)
    expect(store.thread('thread-1')).toMatchObject({ status: 'error', error: { code: 'busy' } })
  })
})
