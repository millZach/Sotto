// @vitest-environment node
// ADR-0198, part 4: a desktop drives a paired host's browser over the socket, and sees its pages as pictures.
import { describe, expect, it, vi } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { HostBrowserService } from '../../src/host/browser/hostBrowserService'
import type { HostBrowser, HostBrowserPage, HostPageFrame, HostPageInput, HostPageState } from '../../src/host/browser/hostBrowser'
import type { BrowserEvent } from '../../src/shared/browser'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { HostBrowserFrame } from '../../src/shared/hostBrowser'
import { rawPeer } from '../fixtures/rawHostPeer'
import { SAME_VERSION_HELD, useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const workspaceId = 'b'.repeat(64)
const workspace = { threadId: 'thread-1', projectId: 'project', workingDirectory: '/work', workspaceId }

/** A page in the host's browser: it moves when told to, takes input, and draws a picture when the test says. */
class FakePage {
  state: HostPageState = { url: 'about:blank', title: '', status: 'ready', error: null, canGoBack: false, canGoForward: false }
  closed = false
  readonly inputs: HostPageInput[] = []
  readonly sizes: { width: number; height: number }[] = []
  private readonly watchers = new Set<(frame: HostPageFrame) => void>()
  private readonly changes = new Set<(state: HostPageState) => void>()
  private readonly closes = new Set<() => void>()
  readonly automation = { observe: vi.fn(), clear: vi.fn(), dispose: vi.fn(), inspect: vi.fn(async () => '{}'), capture: vi.fn(), input: vi.fn(async () => undefined),
    target: vi.fn(async () => 'BUTTON'), evidence: vi.fn(async () => null), thumbnail: vi.fn(async () => null) }
  onChange(listener: (state: HostPageState) => void): () => void { this.changes.add(listener); return () => this.changes.delete(listener) }
  onClose(listener: () => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener) }
  async navigate(url: string): Promise<void> { this.set({ url, status: 'loading' }); this.set({ status: 'ready', title: 'Page' }) }
  async back(): Promise<void> { /* No history. */ }
  async forward(): Promise<void> { /* No history. */ }
  async close(): Promise<void> { this.closed = true; for (const listener of [...this.closes]) listener() }
  async resize(size: { width: number; height: number }): Promise<void> { this.sizes.push(size) }
  async input(event: HostPageInput): Promise<void> { this.inputs.push(event) }
  watch(_size: { width: number; height: number }, deliver: (frame: HostPageFrame) => void): () => void { this.watchers.add(deliver); return () => { this.watchers.delete(deliver) } }
  draw(frame: HostPageFrame): void { for (const deliver of [...this.watchers]) deliver(frame) }
  get watched(): number { return this.watchers.size }
  set(change: Partial<HostPageState>): void { this.state = { ...this.state, ...change }; for (const listener of [...this.changes]) listener(this.state) }
}

async function hostWithBrowser(options: { answers?: boolean; browser?: boolean } = {}) {
  const pages: FakePage[] = []
  const browser = { open: async () => { const page = new FakePage(); pages.push(page); return page as unknown as HostBrowserPage }, dispose: async () => undefined } as unknown as HostBrowser
  const listeners = new Set<(event: BrowserEvent) => void>()
  const saved: boolean[] = []
  const service = new HostBrowserService({ browser, withoutAsking: false, saveWithoutAsking: async value => { saved.push(value) },
    emit: event => { for (const listener of listeners) listener(event) },
    files: { resolveWorkspace: async () => ({ ok: true as const, value: workspace }), hasThread: () => true } })
  const known = new Set<string>()
  const server = await startSocketServer({ service: fixture.host.service, pairing: fixture.host.pairing, mayAnswer: () => options.answers === true,
    watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined },
    ...options.browser === false ? {} : { browser: { service, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } } } })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
  known.add(paired.clientId)
  const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
  return { server, desktop, pages, service, saved, close: async () => { desktop.frames.close(); await server.close(); await service.shutDown() } }
}
const result = (message: Record<string, unknown>) => (message as { result: { ok: boolean; value?: unknown; error?: { message: string } } }).result
const pushed = (messages: readonly Record<string, unknown>[], event: string) => messages.filter(message => message.event === event)

describe('a paired host\'s browser over the socket (ADR-0198)', () => {
  it('lets a desktop open and drive a page, hear it change, and see it as pictures while it watches', async () => {
    const { desktop, pages, close } = await hostWithBrowser()
    try {
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['browser'] }) as { result: { features: string[] } }
      expect(hello.result.features).toContain('browser')
      const created = result(await desktop.call('create', { op: 'browser', request: { method: 'create', payload: { threadId: 'thread-1', workspaceId, url: 'http://127.0.0.1:5173/' } } }))
      expect(created.ok).toBe(true)
      const pageId = (created.value as { id: string }).id
      await expect.poll(() => pushed(desktop.messages, 'browser').some(message => (message.change as BrowserEvent).type === 'page')).toBe(true)

      expect(result(await desktop.call('watch', { op: 'browser', request: { method: 'watch', payload: { threadId: 'thread-1', workspaceId, pageId, size: { width: 800, height: 600 } } } })).ok).toBe(true)
      expect(pages[0]!.sizes.at(-1)).toEqual({ width: 800, height: 600 })
      pages[0]!.draw({ data: 'AAAA', width: 800, height: 600 })
      await expect.poll(() => pushed(desktop.messages, 'browser-frame').length).toBe(1)
      expect(pushed(desktop.messages, 'browser-frame')[0]!.frame).toEqual({ pageId, data: 'AAAA', width: 800, height: 600 })
      // A picture too large for a frame is dropped, not sent as an error.
      pages[0]!.draw({ data: 'A'.repeat(4 * 1024 * 1024 + 1), width: 800, height: 600 })

      const input = { type: 'mouse', action: 'down', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 0 }
      expect(result(await desktop.call('input', { op: 'browser', request: { method: 'input', payload: { threadId: 'thread-1', workspaceId, pageId, input } } })).ok).toBe(true)
      expect(pages[0]!.inputs).toEqual([input])

      expect(result(await desktop.call('unwatch', { op: 'browser', request: { method: 'unwatch', payload: { threadId: 'thread-1', workspaceId, pageId } } })).ok).toBe(true)
      expect(pages[0]!.watched).toBe(0)
      expect(pushed(desktop.messages, 'browser-frame')).toHaveLength(1)
    } finally { await close() }
  })

  it('lets only a desktop that may answer answer a waiting request, and any desktop share or stop it', async () => {
    const quiet = await hostWithBrowser({ answers: false })
    try {
      await quiet.desktop.call('hello', { op: 'hello', accepts: ['browser'] })
      const opened = await quiet.service.agentOpen({ threadId: 'thread-1', workspaceId, url: 'http://127.0.0.1:5173/', description: 'Check it' })
      if (!opened.ok) throw new Error(opened.error.message)
      const answer = { threadId: 'thread-1', workspaceId, pageId: opened.value.task.pageId, taskId: opened.value.task.id, actionId: opened.value.task.pendingAction!.id, allow: true }
      const refused = await quiet.desktop.call('answer', { op: 'browser', request: { method: 'answerAction', payload: answer } }) as { ok: boolean; error: { code: string } }
      expect(refused.ok).toBe(false)
      expect(refused.error.code).toBe('forbidden')
      expect(quiet.pages[0]!.state.url).toBe('about:blank')
      expect(result(await quiet.desktop.call('stop', { op: 'browser', request: { method: 'stopGrant', payload: { threadId: 'thread-1', workspaceId } } })).ok).toBe(true)
    } finally { await quiet.close() }

    const allowed = await hostWithBrowser({ answers: true })
    try {
      await allowed.desktop.call('hello', { op: 'hello', accepts: ['browser'] })
      const opened = await allowed.service.agentOpen({ threadId: 'thread-1', workspaceId, url: 'http://127.0.0.1:5173/', description: 'Check it' })
      if (!opened.ok) throw new Error(opened.error.message)
      const answer = { threadId: 'thread-1', workspaceId, pageId: opened.value.task.pageId, taskId: opened.value.task.id, actionId: opened.value.task.pendingAction!.id, allow: true }
      expect(result(await allowed.desktop.call('answer', { op: 'browser', request: { method: 'answerAction', payload: answer } })).ok).toBe(true)
      expect(allowed.pages[0]!.state.url).toBe('http://127.0.0.1:5173/')
    } finally { await allowed.close() }
  })

  it('reaches a desktop\'s own client: its requests, the host\'s changes and the pictures of a page it watches', async () => {
    const { server, pages, close } = await hostWithBrowser()
    const url = 'http://127.0.0.1:' + server.descriptor.port
    const paired = await SocketHostService.pair(url, fixture.host.pairing.issuePairingCode().code, 'Desktop client')
    const client = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, heldProviders: SAME_VERSION_HELD, pairedHostBrowser: true })
    try {
      await client.connect()
      expect(client.supportsBrowser).toBe(true)
      const changes: BrowserEvent[] = [], frames: HostBrowserFrame[] = []
      client.subscribeBrowser(change => changes.push(change)); client.subscribeBrowserFrames(frame => frames.push(frame))
      const created = await client.browser({ method: 'create', payload: { threadId: 'thread-1', workspaceId, url: 'http://127.0.0.1:5173/' } })
      if (!created.ok) throw new Error(created.error.message)
      await expect.poll(() => changes.some(change => change.type === 'page' && change.page.id === created.value.id)).toBe(true)
      const watched = await client.browser({ method: 'watch', payload: { threadId: 'thread-1', workspaceId, pageId: created.value.id, size: { width: 640, height: 480 } } })
      expect(watched.ok).toBe(true)
      pages[0]!.draw({ data: 'BBBB', width: 640, height: 480 })
      await expect.poll(() => frames).toEqual([{ pageId: created.value.id, data: 'BBBB', width: 640, height: 480 }])
    } finally { await client.close(); await close() }
  })

  it('keeps the setting a desktop that may answer sends, and takes none from one that may not', async () => {
    const allowed = await hostWithBrowser({ answers: true })
    try {
      await allowed.desktop.call('hello', { op: 'hello', accepts: ['browser'] })
      expect(result(await allowed.desktop.call('setting', { op: 'browser', request: { method: 'setting', payload: { withoutAsking: true } } })).ok).toBe(true)
      expect(allowed.service.withoutAsking).toBe(true)
      expect(allowed.saved).toEqual([true])
    } finally { await allowed.close() }
    const quiet = await hostWithBrowser({ answers: false })
    try {
      await quiet.desktop.call('hello', { op: 'hello', accepts: ['browser'] })
      const refused = await quiet.desktop.call('setting', { op: 'browser', request: { method: 'setting', payload: { withoutAsking: true } } }) as { ok: boolean; error: { code: string } }
      expect(refused.ok).toBe(false)
      expect(refused.error.code).toBe('forbidden')
      expect(quiet.service.withoutAsking).toBe(false)
      expect(quiet.saved).toEqual([])
    } finally { await quiet.close() }
  })

  it('takes no browser request from a desktop that did not accept it, and is not listed by a host without the browser', async () => {
    const quiet = await hostWithBrowser()
    try {
      await quiet.desktop.call('hello', { op: 'hello', accepts: [] })
      const refused = await quiet.desktop.call('list', { op: 'browser', request: { method: 'list', payload: { threadId: 'thread-1' } } }) as { ok: boolean; error: { code: string } }
      expect(refused.ok).toBe(false)
      expect(refused.error.code).toBe('invalid_request')
      await quiet.service.agentOpen({ threadId: 'thread-1', workspaceId, url: 'http://127.0.0.1:5173/', description: 'Check it' })
      await quiet.desktop.call('shell', { op: 'shell' })
      expect(pushed(quiet.desktop.messages, 'browser')).toEqual([])
    } finally { await quiet.close() }

    const none = await hostWithBrowser({ browser: false })
    try {
      const hello = await none.desktop.call('hello', { op: 'hello', accepts: ['browser'] }) as { result: { features: string[] } }
      expect(hello.result.features).not.toContain('browser')
    } finally { await none.close() }
  })
})
