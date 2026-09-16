import { useCallback, useSyncExternalStore } from 'react'
import type { FileWorkspace } from '../../../shared/files'
import type { TerminalBridge, TerminalEvent, TerminalSession, TerminalSnapshot } from '../../../shared/terminal'
import type { ToolsError, ToolsResult } from '../../../shared/tools'

/** What the store needs from a rendered terminal. The xterm implementation lives in terminalView.ts. */
export interface TerminalViewLike {
  /** Moves the terminal's element into `container`, opening it the first time. */
  mount(container: HTMLElement): void
  /** Takes the element out of the page; the terminal and its scrollback stay. */
  unmount(): void
  write(data: string, done?: () => void): void
  reset(): void
  setInputEnabled(enabled: boolean): void
  /** Fits to the mounted container; null while it has no size. */
  fit(): { readonly cols: number; readonly rows: number } | null
  focus(): void
  dispose(): void
}

export interface TerminalViewHandlers {
  readonly onInput: (data: string) => void
  readonly onInterrupt: () => void
  /** An image was pasted: its PNG as a data URL. Left out where images have nowhere to go. */
  readonly onPasteImage?: ((dataUrl: string) => void) | undefined
}

export type TerminalViewFactory = (handlers: TerminalViewHandlers) => TerminalViewLike

export interface ThreadTerminals {
  readonly threadId: string
  readonly workspace: FileWorkspace | null
  readonly status: 'loading' | 'ready' | 'error'
  readonly error: ToolsError | null
  readonly sessions: readonly TerminalSession[]
  readonly activeSessionId: string | null
  /** A create, reopen or close is on its way. */
  readonly busy: boolean
  /** The last action that failed, in words. */
  readonly notice: string | null
}

type OutputEvent = Extract<TerminalEvent, { type: 'output' }>

interface SessionRecord {
  threadId: string
  view: TerminalViewLike | null
  /** Highest output sequence written to the view. */
  sequence: number
  /** A snapshot is being read or replayed: output waits in `buffer` and input is off. */
  replaying: boolean
  buffer: OutputEvent[]
  loaded: boolean
  /** A snapshot main returned before the session had a view (create, reopen); the view replays it when it first mounts. */
  pending: TerminalSnapshot | null
  size: { cols: number; rows: number } | null
  loadError: string | null
}

const unavailable: ToolsError = { code: 'unavailable', message: 'Terminal is not available in this window.' }
const ORPHAN_LIMIT = 256

/**
 * Terminal sessions per thread, and the one subscription that feeds every rendered terminal. Main owns each PTY;
 * this store only shows it: subscribe first, read the snapshot with input off, replay it, then apply only output
 * newer than the snapshot. Hiding a terminal takes its element off the page and never closes the session.
 */
export class TerminalStore {
  private readonly threads = new Map<string, ThreadTerminals>()
  private readonly records = new Map<string, SessionRecord>()
  private readonly listeners = new Set<() => void>()
  /** Output for sessions this window has not registered yet, such as one whose create reply is still on its way. */
  private readonly orphans = new Map<string, OutputEvent[]>()
  private subscribed: TerminalBridge | null = null
  private unsubscribe: (() => void) | null = null
  private listTokens = new Map<string, number>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  thread(threadId: string): ThreadTerminals | undefined { return this.threads.get(threadId) }
  loadError(sessionId: string): string | null { return this.records.get(sessionId)?.loadError ?? null }
  replaying(sessionId: string): boolean { return this.records.get(sessionId)?.replaying ?? false }

  /** Show a thread's sessions: lists them from main, keeping the one that was active. */
  async activate(bridge: TerminalBridge | undefined, threadId: string): Promise<void> {
    const current = this.threads.get(threadId)
    if (!current) this.setThread({ threadId, workspace: null, status: 'loading', error: null, sessions: [], activeSessionId: null, busy: false, notice: null })
    if (!bridge) { this.patch(threadId, { status: 'error', error: unavailable }); return }
    this.listen(bridge)
    const token = (this.listTokens.get(threadId) ?? 0) + 1
    this.listTokens.set(threadId, token)
    const result = await settle(bridge.list({ threadId }))
    if (this.listTokens.get(threadId) !== token) return
    const latest = this.threads.get(threadId)!
    if (!result.ok) { this.patch(threadId, { status: 'error', error: result.error }); return }
    const { workspace, sessions } = result.value
    if (latest.workspace && latest.workspace.workspaceId !== workspace.workspaceId) {
      // A replaced working folder has its own sessions; views for the old one are released.
      for (const session of latest.sessions) this.release(session.id)
    }
    for (const session of sessions) this.ensureRecord(threadId, session.id)
    const active = sessions.some(session => session.id === latest.activeSessionId) ? latest.activeSessionId : sessions.at(-1)?.id ?? null
    this.setThread({ ...latest, workspace, status: 'ready', error: null, sessions, activeSessionId: active })
  }

  select(threadId: string, sessionId: string): void {
    const current = this.threads.get(threadId)
    if (current?.sessions.some(session => session.id === sessionId)) this.patch(threadId, { activeSessionId: sessionId })
  }

  async create(bridge: TerminalBridge | undefined, threadId: string, size?: { cols: number; rows: number }): Promise<void> {
    const target = this.target(threadId)
    if (!bridge || !target) return
    this.listen(bridge)
    this.patch(threadId, { busy: true, notice: null })
    const result = await settle(bridge.create({ ...target, ...(size ?? {}) }))
    if (!result.ok) { this.fail(bridge, threadId, result.error, 'Could not start a terminal.'); return }
    this.adopt(threadId, result.value)
    this.patch(threadId, { busy: false, activeSessionId: result.value.session.id })
  }

  /** A session that exited or ended with the app gets a new shell in the same place. Its old output is not restored. */
  async reopen(bridge: TerminalBridge | undefined, threadId: string, sessionId: string): Promise<void> {
    const target = this.target(threadId)
    const record = this.records.get(sessionId)
    if (!bridge || !target || !record) return
    this.patch(threadId, { busy: true, notice: null })
    record.replaying = true
    record.buffer = []
    record.view?.setInputEnabled(false)
    const result = await settle(bridge.reopen({ ...target, sessionId }))
    if (!result.ok) {
      record.replaying = false
      this.fail(bridge, threadId, result.error, 'Could not reopen this terminal.')
      return
    }
    if (result.value.session.id !== sessionId) this.release(sessionId)
    this.adopt(threadId, result.value, sessionId)
    this.patch(threadId, { busy: false, activeSessionId: result.value.session.id })
  }

  async close(bridge: TerminalBridge | undefined, threadId: string, sessionId: string): Promise<void> {
    const target = this.target(threadId)
    if (!bridge || !target) return
    this.patch(threadId, { busy: true, notice: null })
    const result = await settle(bridge.close({ ...target, sessionId }))
    if (!result.ok && result.error.code !== 'session-unavailable') { this.fail(bridge, threadId, result.error, 'Could not end this terminal.'); return }
    this.removeSession(threadId, sessionId)
    this.patch(threadId, { busy: false })
  }

  write(bridge: TerminalBridge | undefined, threadId: string, sessionId: string, data: string): void {
    const target = this.target(threadId)
    const record = this.records.get(sessionId)
    const session = this.threads.get(threadId)?.sessions.find(item => item.id === sessionId)
    if (!bridge || !target || !record || record.replaying || session?.status !== 'running') return
    // Main takes at most 64 KiB per write; a large paste goes in order, chunk by chunk.
    const chunks = data.match(/[\s\S]{1,16384}/gu) ?? []
    void chunks.reduce<Promise<unknown>>((previous, chunk) => previous.then(() => settle(bridge.write({ ...target, sessionId, data: chunk }))), Promise.resolve())
  }

  interrupt(bridge: TerminalBridge | undefined, threadId: string, sessionId: string): void {
    const target = this.target(threadId)
    if (!bridge || !target) return
    void settle(bridge.interrupt({ ...target, sessionId }))
  }

  /** Sends a new size only when it changed. */
  resize(bridge: TerminalBridge | undefined, threadId: string, sessionId: string, size: { cols: number; rows: number }): void {
    const target = this.target(threadId)
    const record = this.records.get(sessionId)
    if (!bridge || !target || !record) return
    const cols = Math.max(2, Math.min(500, size.cols))
    const rows = Math.max(1, Math.min(300, size.rows))
    if (record.size?.cols === cols && record.size.rows === rows) return
    record.size = { cols, rows }
    void settle(bridge.resize({ ...target, sessionId, cols, rows }))
  }

  /** Puts the session's terminal into `container`, reading and replaying its snapshot the first time. */
  attach(bridge: TerminalBridge | undefined, threadId: string, sessionId: string, container: HTMLElement, factory: TerminalViewFactory): TerminalViewLike | null {
    const record = this.ensureRecord(threadId, sessionId)
    if (!record.view) {
      record.view = factory({
        onInput: data => this.write(bridge, threadId, sessionId, data),
        onInterrupt: () => this.interrupt(bridge, threadId, sessionId),
      })
    }
    record.view.mount(container)
    if (record.pending) {
      const snapshot = record.pending
      record.pending = null
      this.replay(threadId, record, snapshot)
    } else if (!record.loaded && !record.replaying) void this.load(bridge, threadId, sessionId)
    else record.view.setInputEnabled(!record.replaying && this.running(threadId, sessionId))
    return record.view
  }

  detach(sessionId: string): void { this.records.get(sessionId)?.view?.unmount() }

  retry(bridge: TerminalBridge | undefined, threadId: string, sessionId: string): void {
    const record = this.records.get(sessionId)
    if (record && !record.replaying) void this.load(bridge, threadId, sessionId)
  }

  private async load(bridge: TerminalBridge | undefined, threadId: string, sessionId: string): Promise<void> {
    const record = this.records.get(sessionId)
    const target = this.target(threadId)
    if (!record) return
    if (!bridge || !target) { record.loadError = unavailable.message; this.emit(); return }
    this.listen(bridge)
    record.replaying = true
    record.loadError = null
    record.buffer = [...this.orphans.get(sessionId) ?? []]
    this.orphans.delete(sessionId)
    record.view?.setInputEnabled(false)
    this.emit()
    const result = await settle(bridge.read({ ...target, sessionId }))
    if (this.records.get(sessionId) !== record) return
    if (!result.ok) {
      record.replaying = false
      record.loadError = result.error.code === 'session-unavailable' ? 'This terminal is no longer available.' : 'The terminal output could not load.'
      if (result.error.code === 'session-unavailable') void this.activate(bridge, threadId)
      this.emit()
      return
    }
    this.replay(threadId, record, result.value)
  }

  /** Registers a snapshot main just returned (create or reopen) and replays it. */
  private adopt(threadId: string, snapshot: TerminalSnapshot, replacing?: string): void {
    const id = snapshot.session.id
    const previous = replacing === undefined ? undefined : this.records.get(replacing)
    const record = this.ensureRecord(threadId, id)
    if (previous && previous !== record) { record.view = previous.view; previous.view = null; record.buffer = previous.buffer }
    const buffered = this.orphans.get(id) ?? []
    this.orphans.delete(id)
    record.buffer = [...record.buffer, ...buffered]
    this.upsertSession(threadId, snapshot.session, replacing)
    this.replay(threadId, record, snapshot)
  }

  private replay(threadId: string, record: SessionRecord, snapshot: TerminalSnapshot): void {
    this.upsertSession(threadId, snapshot.session)
    record.loaded = true
    if (!record.view) {
      // Output keeps arriving into the buffer; the snapshot and anything newer are written once a view exists.
      record.pending = snapshot
      record.replaying = false
      this.emit()
      return
    }
    record.replaying = true
    const finish = (): void => {
      record.sequence = snapshot.sequence
      const pending = record.buffer.filter(event => event.sequence > record.sequence).sort((a, b) => a.sequence - b.sequence)
      record.buffer = []
      for (const event of pending) {
        if (event.sequence <= record.sequence) continue
        record.view?.write(event.data)
        record.sequence = event.sequence
      }
      record.replaying = false
      record.view?.setInputEnabled(this.running(threadId, snapshot.session.id))
      this.emit()
    }
    record.view.reset()
    if (snapshot.output) record.view.write(snapshot.output, finish)
    else finish()
  }

  private listen(bridge: TerminalBridge): void {
    if (this.subscribed === bridge) return
    this.unsubscribe?.()
    this.subscribed = bridge
    this.unsubscribe = bridge.onEvent(event => this.receive(bridge, event))
  }

  private receive(bridge: TerminalBridge, event: TerminalEvent): void {
    if (event.type === 'output') {
      const record = this.records.get(event.sessionId)
      if (!record) {
        const queue = this.orphans.get(event.sessionId) ?? []
        if (queue.length < ORPHAN_LIMIT) queue.push(event)
        this.orphans.set(event.sessionId, queue)
        return
      }
      if (record.replaying || !record.loaded || record.pending) { record.buffer.push(event); return }
      if (event.sequence <= record.sequence) return
      record.view?.write(event.data)
      record.sequence = event.sequence
      return
    }
    if (event.type === 'session') {
      const threadId = event.session.workspace.threadId
      const thread = this.threads.get(threadId)
      if (!thread || thread.workspace?.workspaceId !== event.session.workspace.workspaceId) return
      this.upsertSession(threadId, event.session)
      const record = this.records.get(event.session.id)
      if (record && !record.replaying) record.view?.setInputEnabled(event.session.status === 'running')
      this.emit()
      return
    }
    const thread = this.threads.get(event.threadId)
    if (thread?.sessions.some(session => session.id === event.sessionId)) this.removeSession(event.threadId, event.sessionId)
    void bridge
  }

  private upsertSession(threadId: string, session: TerminalSession, replacing?: string): void {
    const thread = this.threads.get(threadId)
    if (!thread) return
    const index = thread.sessions.findIndex(item => item.id === (replacing ?? session.id))
    const sessions = index < 0 ? [...thread.sessions, session] : thread.sessions.map((item, position) => position === index ? session : item)
    this.setThread({ ...thread, sessions })
  }

  private removeSession(threadId: string, sessionId: string): void {
    const thread = this.threads.get(threadId)
    this.release(sessionId)
    if (!thread) return
    const index = thread.sessions.findIndex(session => session.id === sessionId)
    const sessions = thread.sessions.filter(session => session.id !== sessionId)
    const active = thread.activeSessionId === sessionId ? sessions[Math.min(Math.max(index, 0), sessions.length - 1)]?.id ?? null : thread.activeSessionId
    this.setThread({ ...thread, sessions, activeSessionId: active })
  }

  private release(sessionId: string): void {
    const record = this.records.get(sessionId)
    record?.view?.dispose()
    this.records.delete(sessionId)
    this.orphans.delete(sessionId)
  }

  private ensureRecord(threadId: string, sessionId: string): SessionRecord {
    let record = this.records.get(sessionId)
    if (!record) {
      record = { threadId, view: null, sequence: 0, replaying: false, buffer: [], loaded: false, pending: null, size: null, loadError: null }
      this.records.set(sessionId, record)
    }
    return record
  }

  private running(threadId: string, sessionId: string): boolean {
    return this.threads.get(threadId)?.sessions.find(session => session.id === sessionId)?.status === 'running'
  }

  private target(threadId: string): { threadId: string; workspaceId: string } | null {
    const workspace = this.threads.get(threadId)?.workspace
    return workspace ? { threadId, workspaceId: workspace.workspaceId } : null
  }

  private fail(bridge: TerminalBridge, threadId: string, error: ToolsError, words: string): void {
    this.patch(threadId, { busy: false, notice: error.code === 'busy' ? 'Terminal is busy. Try again in a moment.' : `${words} ${error.message}`.trim() })
    if (error.code === 'workspace-changed' || error.code === 'session-unavailable') void this.activate(bridge, threadId)
  }

  private patch(threadId: string, patch: Partial<ThreadTerminals>): void {
    const thread = this.threads.get(threadId)
    if (thread) this.setThread({ ...thread, ...patch })
  }

  private setThread(next: ThreadTerminals): void {
    this.threads.set(next.threadId, next)
    this.emit()
  }

  private emit(): void { for (const listener of [...this.listeners]) listener() }
}

async function settle<T>(request: Promise<ToolsResult<T>>): Promise<ToolsResult<T>> {
  try { return await request } catch { return { ok: false, error: { code: 'unavailable', message: 'Sotto did not answer.' } } }
}

export function useThreadTerminals(store: TerminalStore, threadId: string | null): ThreadTerminals | undefined {
  const read = useCallback(() => threadId === null ? undefined : store.thread(threadId), [store, threadId])
  return useSyncExternalStore(store.subscribe, read)
}

/** How a session reads in its tab and status line. */
export function sessionStatusText(session: TerminalSession): string {
  switch (session.status) {
    case 'running': return 'Running'
    case 'exited': return session.exitCode === null ? 'Exited' : `Exited with code ${session.exitCode}`
    case 'interrupted': return 'Ended when Sotto closed'
    default: return 'Could not start'
  }
}
