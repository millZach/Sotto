import { terminalBridgeFixture, terminalSession } from '../../../fixtures/renderer/terminalBridge'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalSession, TerminalSnapshot } from '../../../../src/shared/terminal'
import type { ToolsResult } from '../../../../src/shared/tools'
import { TerminalStore, type TerminalViewHandlers } from '../../../../src/renderer/src/tools/terminalStore'

const workspace = { threadId: 'thread-a', projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
const ID_TOOLS = '11111111-1111-4111-8111-111111111111'
const ID_DRAWER = '22222222-2222-4222-8222-222222222222'
const session = (id: string, place: 'tools' | 'drawer', patch: Partial<TerminalSession> = {}): TerminalSession =>
  terminalSession(id, workspace, { place, ...patch })
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })

/** A bridge whose `list` answers whatever place it was asked for, like the main service does. */
function fakeBridge(sessions: TerminalSession[]) {
  const { bridge, publish } = terminalBridgeFixture({ workspace, sessions,
    commands: { list: vi.fn(async ({ place }) => ok({ workspace, sessions: sessions.filter(session => session.place === (place ?? 'tools')) })),
    create: vi.fn(async () => ok({ session: session(ID_TOOLS, 'tools'), output: '', sequence: 0 } as TerminalSnapshot)),
    reopen: vi.fn(async ({ sessionId }) => ok({ session: sessions.find(item => item.id === sessionId)!, output: '', sequence: 0 })) } })
  return { bridge, emit: publish }
}

describe('a terminal store filters by place', () => {
  it.each(['tools', 'drawer'] as const)('keeps conversion, staging, later pastes and Enter ordered in %s', async place => {
    const { bridge } = fakeBridge([session(ID_TOOLS, place)])
    const store = new TerminalStore(place)
    await store.activate(bridge, 'thread-a')
    let handlers!: TerminalViewHandlers
    store.attach(bridge, 'thread-a', ID_TOOLS, document.createElement('div'), callbacks => {
      handlers = callbacks
      return { mount() {}, unmount() {}, write(_data, done) { done?.() }, reset() {}, setInputEnabled() {}, fit: () => null, focus() {}, dispose() {} }
    })
    await vi.waitFor(() => expect(store.replaying(ID_TOOLS)).toBe(false))
    const conversion = Promise.withResolvers<string | null>(), staging = Promise.withResolvers<ToolsResult<void>>()
    const calls: string[] = []
    vi.mocked(bridge.pasteImage).mockImplementationOnce(request => { calls.push(request.dataUrl); return staging.promise })
      .mockImplementation(async request => { calls.push(request.dataUrl); return ok(undefined) })
    vi.mocked(bridge.write).mockImplementation(async request => { calls.push(request.data); return ok(undefined) })
    handlers.onPasteImage!(conversion.promise)
    handlers.onPasteImage!('second image')
    handlers.onInput('\r')
    await Promise.resolve(); await Promise.resolve()
    expect(calls).toEqual([])
    conversion.resolve('first image')
    await vi.waitFor(() => expect(calls).toEqual(['first image']))
    staging.resolve(ok(undefined))
    await vi.waitFor(() => expect(calls).toEqual(['first image', 'second image', '\r']))
    const failed = Promise.withResolvers<string | null>()
    handlers.onPasteImage!(failed.promise); handlers.onInput('\r')
    failed.resolve(null)
    await vi.waitFor(() => expect(store.thread('thread-a')!.notice).toContain('clipboard image could not be read'))
    expect(store.thread('thread-a')!.notice).toContain('Later queued input was discarded.')
    expect(calls).toEqual(['first image', 'second image', '\r'])
    handlers.onInput('fresh')
    await vi.waitFor(() => expect(calls.at(-1)).toBe('fresh'))
  })
  it.each(['tools', 'drawer'] as const)('routes pasted images from %s to its running session, and reports a save failure', async place => {
    const { bridge, emit } = fakeBridge([session(ID_TOOLS, place)])
    const store = new TerminalStore(place)
    await store.activate(bridge, 'thread-a')
    let handlers: TerminalViewHandlers | undefined
    store.attach(bridge, 'thread-a', ID_TOOLS, document.createElement('div'), callbacks => {
      handlers = callbacks
      return { mount() {}, unmount() {}, write(_data, done) { done?.() }, reset() {}, setInputEnabled() {}, fit: () => null, focus() {}, dispose() {} }
    })
    await vi.waitFor(() => expect(store.replaying(ID_TOOLS)).toBe(false))
    handlers!.onPasteImage!('data:image/png;base64,AAAA')
    await vi.waitFor(() => expect(bridge.pasteImage).toHaveBeenCalledWith({ threadId: 'thread-a', workspaceId: workspace.workspaceId, sessionId: ID_TOOLS, dataUrl: 'data:image/png;base64,AAAA' }))
    handlers!.onPasteImage!('data:image/png;base64,' + 'A'.repeat(Math.ceil(11 * 1024 * 1024 * 4 / 3)))
    await vi.waitFor(() => expect(store.thread('thread-a')!.notice).toContain('larger than 10 MiB'))
    expect(bridge.pasteImage).toHaveBeenCalledOnce()
    vi.mocked(bridge.pasteImage).mockResolvedValueOnce({ ok: false, error: { code: 'path-unavailable', message: 'The image could not be saved under this folder.' } })
    handlers!.onPasteImage!('data:image/png;base64,BBBB')
    await vi.waitFor(() => expect(store.thread('thread-a')!.notice).toContain('The image could not be saved under this folder.'))
    emit({ type: 'session', session: session(ID_TOOLS, place, { status: 'exited' }) })
    handlers!.onPasteImage!('data:image/png;base64,CCCC')
    expect(bridge.pasteImage).toHaveBeenCalledTimes(2)
    await store.close(bridge, 'thread-a', ID_TOOLS)
  })
  it('lists only its own place, passing it on every list and create call', async () => {
    const { bridge } = fakeBridge([session(ID_TOOLS, 'tools'), session(ID_DRAWER, 'drawer')])
    const toolsStore = new TerminalStore('tools')
    const drawerStore = new TerminalStore('drawer')
    await toolsStore.activate(bridge, 'thread-a')
    await drawerStore.activate(bridge, 'thread-a')
    expect(bridge.list).toHaveBeenCalledWith({ threadId: 'thread-a', place: 'tools' })
    expect(bridge.list).toHaveBeenCalledWith({ threadId: 'thread-a', place: 'drawer' })
    expect(toolsStore.thread('thread-a')?.sessions.map(item => item.id)).toEqual([ID_TOOLS])
    expect(drawerStore.thread('thread-a')?.sessions.map(item => item.id)).toEqual([ID_DRAWER])
    await toolsStore.create(bridge, 'thread-a')
    expect(bridge.create).toHaveBeenCalledWith({ threadId: 'thread-a', workspaceId: workspace.workspaceId, place: 'tools' })
  })

  it('ignores a session event for the other place, so it never shows up in the wrong surface', async () => {
    const { bridge, emit } = fakeBridge([session(ID_TOOLS, 'tools')])
    const toolsStore = new TerminalStore('tools')
    await toolsStore.activate(bridge, 'thread-a')
    emit({ type: 'session', session: session(ID_DRAWER, 'drawer', { title: 'cmd' }) })
    expect(toolsStore.thread('thread-a')?.sessions.map(item => item.id)).toEqual([ID_TOOLS])
  })

  it('drops output for the other place instead of buffering it as an orphan a same-ID session would later replay', async () => {
    // A session with this ID in the drawer's place; this store only knows Tools' own session of the same ID.
    const { bridge, emit } = fakeBridge([session(ID_DRAWER, 'tools')])
    const toolsStore = new TerminalStore('tools')
    await toolsStore.activate(bridge, 'thread-a')
    emit({ type: 'output', threadId: 'thread-a', workspaceId: workspace.workspaceId, sessionId: ID_DRAWER, data: 'hello', sequence: 1, place: 'drawer' })
    const container = document.createElement('div')
    const written: string[] = []
    toolsStore.attach(bridge, 'thread-a', ID_DRAWER, container, () => ({
      mount: () => {}, unmount: () => {}, write: (data, done) => { written.push(data); done?.() }, reset: () => written.push('<reset>'),
      setInputEnabled: () => {}, fit: () => null, focus: () => {}, dispose: () => {},
    }))
    await vi.waitFor(() => expect(written).toContain('<reset>'))
    expect(written).not.toContain('hello')
  })
})
