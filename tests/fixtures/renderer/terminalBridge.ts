import { vi } from 'vitest'
import type { FileWorkspace } from '../../../src/shared/files'
import type { TerminalBridge, TerminalEvent, TerminalSession, TerminalSnapshot } from '../../../src/shared/terminal'
import type { TerminalViewFactory, TerminalViewHandlers } from '../../../src/renderer/src/tools/terminalStore'
import { deferred } from '../deferred'
import { bridgePublication } from './bridgePublication'

export function terminalSession(id: string, workspace: FileWorkspace, patch: Partial<TerminalSession> = {}): TerminalSession {
  return structuredClone({ id, workspace, title: 'PowerShell', shell: 'pwsh.exe', status: 'running', cols: 80, rows: 24,
    exitCode: null, createdAt: 1, place: 'tools', ...patch })
}

export function terminalBridgeFixture(options: { workspace: FileWorkspace; sessions?: TerminalSession[];
  snapshots?: Record<string, TerminalSnapshot>; commands?: Partial<Omit<TerminalBridge, 'onEvent'>> }) {
  const events = bridgePublication<TerminalEvent>()
  let sessions = structuredClone(options.sessions ?? [])
  const hold = { read: false }
  const pendingRead: { release: (() => void) | null } = { release: null }
  const reads = new Set<() => void>()
  const bridge: TerminalBridge = {
    list: vi.fn<TerminalBridge['list']>(async () => ({ ok: true, value: { workspace: options.workspace, sessions, capacity: { count: sessions.length, version: 0 } } })),
    create: vi.fn<TerminalBridge['create']>(),
    read: vi.fn<TerminalBridge['read']>(async ({ sessionId }) => {
      if (hold.read) {
        const gate = deferred()
        const release = () => gate.resolve()
        reads.add(release); pendingRead.release = release
        try { await gate.promise } finally { reads.delete(release) }
      }
      return { ok: true, value: options.snapshots?.[sessionId] ?? { session: sessions.find(item => item.id === sessionId)!, output: '', sequence: 0 } }
    }),
    write: vi.fn<TerminalBridge['write']>(async () => ({ ok: true, value: undefined })), resize: vi.fn<TerminalBridge['resize']>(async () => ({ ok: true, value: undefined })),
    interrupt: vi.fn<TerminalBridge['interrupt']>(async () => ({ ok: true, value: undefined })),
    close: vi.fn<TerminalBridge['close']>(async ({ sessionId }) => { sessions = sessions.filter(item => item.id !== sessionId); return { ok: true, value: undefined } }),
    reopen: vi.fn<TerminalBridge['reopen']>(), onEvent: events.subscribe, ...options.commands,
  }
  return { ...events, bridge, hold, pendingRead, sessions: () => sessions, setSessions: (next: TerminalSession[]) => { sessions = next },
    dispose: () => { hold.read = false; for (const release of reads) release(); events.dispose() },
  }
}

/** No xterm dependency. Records paint/input/lifecycle calls and exposes the handlers to the case. */
export function fakeTerminalViews(options: { tag?: 'pre' | 'textarea'; className?: string; fit?: { cols: number; rows: number } | null } = {}) {
  const views: { handlers: TerminalViewHandlers; written: string[]; input: boolean[]; mounts: number; unmounts: number; focused: number; disposed: boolean }[] = []
  const factory: TerminalViewFactory = handlers => {
    const record = { handlers, written: [] as string[], input: [] as boolean[], mounts: 0, unmounts: 0, focused: 0, disposed: false }
    views.push(record)
    return {
      mount: container => { record.mounts += 1; container.replaceChildren(Object.assign(document.createElement(options.tag ?? 'pre'), { className: options.className ?? 'fake-xterm' })) },
      unmount: () => { record.unmounts += 1 }, write: (data, done) => { record.written.push(data); done?.() },
      reset: () => { record.written.push('<reset>') }, setInputEnabled: enabled => { record.input.push(enabled) },
      fit: () => options.fit === undefined ? { cols: 100, rows: 30 } : options.fit,
      focus: () => { record.focused += 1 }, dispose: () => { record.disposed = true },
    }
  }
  return { views, factory }
}
