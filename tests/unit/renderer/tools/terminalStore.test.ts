import { terminalBridgeFixture, terminalSession } from '../../../fixtures/renderer/terminalBridge'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalEvent, TerminalSession, TerminalSnapshot } from '../../../../src/shared/terminal'
import type { ToolsResult } from '../../../../src/shared/tools'
import { TerminalStore } from '../../../../src/renderer/src/tools/terminalStore'

const workspace = { threadId: 'thread-a', projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
const ID_TOOLS = '11111111-1111-4111-8111-111111111111'
const ID_DRAWER = '22222222-2222-4222-8222-222222222222'
const session = (id: string, place: 'tools' | 'drawer', patch: Partial<TerminalSession> = {}): TerminalSession =>
  terminalSession(id, workspace, { id, workspace, title: 'PowerShell', shell: 'pwsh.exe', status: 'running', cols: 80, rows: 24, exitCode: null, createdAt: 1, place, ...patch })
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })

/** A bridge whose `list` answers whatever place it was asked for, like the main service does. */
function fakeBridge(sessions: TerminalSession[]) {

  const { bridge, listeners } = terminalBridgeFixture({ workspace,
    commands: { list: vi.fn(async ({ place }) => ok({ workspace, sessions: sessions.filter(session => session.place === (place ?? 'tools')) })),
    create: vi.fn(async () => ok({ session: session(ID_TOOLS, 'tools'), output: '', sequence: 0 } as TerminalSnapshot)),
    read: vi.fn(async ({ sessionId }) => ok({ session: sessions.find(item => item.id === sessionId)!, output: '', sequence: 0 })),
    write: vi.fn(async () => ok(undefined)),
    resize: vi.fn(async () => ok(undefined)),
    interrupt: vi.fn(async () => ok(undefined)),
    close: vi.fn(async () => ok(undefined)),
    reopen: vi.fn(async ({ sessionId }) => ok({ session: sessions.find(item => item.id === sessionId)!, output: '', sequence: 0 })) } })
  return { bridge, emit: (event: TerminalEvent) => { for (const listener of [...listeners]) listener(event) } }
}

describe('a terminal store filters by place', () => {
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
