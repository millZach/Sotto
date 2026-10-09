import { describe, expect, it, vi } from 'vitest'
import type { TerminalBridge, TerminalEvent, TerminalSession, TerminalSnapshot } from '../../../../src/shared/terminal'
import type { ToolsResult } from '../../../../src/shared/tools'
import { TerminalStore } from '../../../../src/renderer/src/tools/terminalStore'

const workspace = { threadId: 'thread-a', projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
const ID_TOOLS = '11111111-1111-4111-8111-111111111111'
const ID_DRAWER = '22222222-2222-4222-8222-222222222222'
const session = (id: string, place: 'tools' | 'drawer', patch: Partial<TerminalSession> = {}): TerminalSession =>
  ({ id, workspace, title: 'PowerShell', shell: 'pwsh.exe', status: 'running', cols: 80, rows: 24, exitCode: null, createdAt: 1, place, ...patch })
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })

it('uses the newest shared capacity even when an older thread list arrives afterwards', async () => {
  const f = fakeBridge([])
  const stores = [new TerminalStore('tools'), new TerminalStore('drawer')]
  const listing = Promise.withResolvers<Awaited<ReturnType<TerminalBridge['list']>>>()
  vi.mocked(f.bridge.list).mockImplementation(() => listing.promise)
  const pending = stores.map(store => store.activate(f.bridge, workspace.threadId))
  f.emit({ type: 'capacity', capacity: { count: 32, version: 2 } })
  listing.resolve(ok({ workspace, sessions: [], capacity: { count: 31, version: 1 } }))
  await Promise.all(pending)
  for (const store of stores) expect(store.sessionCount()).toBe(32)
  f.emit({ type: 'capacity', capacity: { count: 31, version: 3 } })
  for (const store of stores) expect(store.sessionCount()).toBe(31)
})

/** A bridge whose `list` answers whatever place it was asked for, like the main service does. */
function fakeBridge(sessions: TerminalSession[]) {
  const listeners = new Set<(event: TerminalEvent) => void>()
  const bridge: TerminalBridge = {
    list: vi.fn(async ({ place }) => ok({ workspace, sessions: sessions.filter(session => session.place === (place ?? 'tools')), capacity: { count: sessions.length, version: 0 } })),
    create: vi.fn(async () => ok({ session: session(ID_TOOLS, 'tools'), output: '', sequence: 0 } as TerminalSnapshot)),
    read: vi.fn(async ({ sessionId }) => ok({ session: sessions.find(item => item.id === sessionId)!, output: '', sequence: 0 })),
    write: vi.fn(async () => ok(undefined)),
    resize: vi.fn(async () => ok(undefined)),
    interrupt: vi.fn(async () => ok(undefined)),
    close: vi.fn(async () => ok(undefined)),
    reopen: vi.fn(async ({ sessionId }) => ok({ session: sessions.find(item => item.id === sessionId)!, output: '', sequence: 0 })),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge, emit: (event: TerminalEvent) => { for (const listener of [...listeners]) listener(event) } }
}

describe('a terminal store filters by place', () => {
  it.each([
    ['tools', true], ['tools', false], ['drawer', true], ['drawer', false],
  ] as const)('keeps one reopened %s shell when its events arrive before the reply (close first=%s)', async (place, closeFirst) => {
    const f = fakeBridge([session(ID_TOOLS, place, { status: 'interrupted' })])
    const store = new TerminalStore(place)
    await store.activate(f.bridge, workspace.threadId)
    const reply = Promise.withResolvers<ToolsResult<TerminalSnapshot>>()
    vi.mocked(f.bridge.reopen).mockImplementationOnce(() => reply.promise)
    const pending = store.reopen(f.bridge, workspace.threadId, ID_TOOLS)
    const replacement = session(ID_DRAWER, place)
    const closed = { type: 'closed' as const, threadId: workspace.threadId, workspaceId: workspace.workspaceId, sessionId: ID_TOOLS }
    f.emit({ type: 'session', session: replacement })
    if (closeFirst) f.emit(closed)
    reply.resolve(ok({ session: replacement, output: '', sequence: 0 }))
    await pending
    if (!closeFirst) f.emit(closed)
    expect(store.thread(workspace.threadId)?.sessions.map(item => item.id)).toEqual([ID_DRAWER])
    expect(store.thread(workspace.threadId)?.activeSessionId).toBe(ID_DRAWER)
    await store.close(f.bridge, workspace.threadId, ID_DRAWER)
    expect(store.thread(workspace.threadId)?.sessions).toEqual([])
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
