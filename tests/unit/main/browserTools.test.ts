// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebContentsView } from 'electron'
import { BrowserService } from '../../../src/main/tools/browser'
import { FilesService } from '../../../src/main/files/service'
import type { ToolsResult } from '../../../src/shared/tools'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    url = ''; destroyed = false
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
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
  return { WebContentsView: vi.fn(class { webContents = new Contents(); setBounds = vi.fn() }), session: { fromPartition: () => new IsolatedSession() } }
})
const unwrap = <T>(result: ToolsResult<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.clearAllMocks() })
describe('browser service lifecycle', () => {
  it('keeps failed navigation unavailable when Chromium finishes an error document, then supports explicit reload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-browser-unit-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory: directory }), copyPath: vi.fn(), reveal: vi.fn() })
    const emit = vi.fn(), openExternal = vi.fn().mockResolvedValue(undefined)
    const service = new BrowserService({ files, getWindow: () => null, emit, openExternal, destination: async () => 'external' })
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
