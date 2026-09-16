import { useSyncExternalStore } from 'react'
import type { TerminalOpenRequest, TerminalWorkspaceBridge, WorkspaceTerminal, WorkspaceTerminalEvent, WorkspaceTerminalSnapshot } from '../../../shared/terminalWorkspace'
import type { ToolsError, ToolsResult } from '../../../shared/tools'
import type { TerminalViewFactory, TerminalViewLike } from '../tools/terminalStore'
import { lastNotableLine } from './terminalFacts'

export interface TerminalWorkspaceState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: ToolsError | null
  readonly terminals: readonly WorkspaceTerminal[]
  /** The shell a terminal without a provider opens, as main names it; null until main has been asked. */
  readonly shell: string | null
  /** An open, restart or close is on its way. */
  readonly busy: boolean
  /** The last action that failed, in words. */
  readonly notice: string | null
}

type OutputEvent = Extract<WorkspaceTerminalEvent, { type: 'output' }>

interface TerminalRecord {
  view: TerminalViewLike | null
  /** Highest output sequence written to the view. */
  sequence: number
  /** A snapshot is being read or replayed: output waits in `buffer` and input is off. */
  replaying: boolean
  buffer: OutputEvent[]
  loaded: boolean
  /** A snapshot main returned before the terminal had a view; the view replays it when it first mounts. */
  pending: WorkspaceTerminalSnapshot | null
  size: { cols: number; rows: number } | null
  loadError: string | null
  /** When output last arrived, for Running against Idle in the sidebar. */
  lastOutputAt: number
  /** The end of the output, for the sidebar's last notable line. */
  tail: string
  /** A pasted image's path, shown briefly in the pane. */
  pasted: { readonly path: string; readonly at: number } | null
}

const unavailable: ToolsError = { code: 'unavailable', message: 'Terminal is not available in this window.' }
const ORPHAN_LIMIT = 256
const TAIL_LIMIT = 2_000
const IDLE: TerminalWorkspaceState = { status: 'idle', error: null, terminals: [], shell: null, busy: false, notice: null }

/**
 * Terminal mode's terminals and the one subscription that feeds every rendered one. Main owns each PTY; this
 * store only shows it: subscribe first, read the snapshot with input off, replay it, then apply only newer output.
 * Hiding a pane takes its element off the page and never closes the terminal.
 */
export class TerminalWorkspaceStore {
  private state: TerminalWorkspaceState = IDLE
  private readonly records = new Map<string, TerminalRecord>()
  private readonly listeners = new Set<() => void>()
  private readonly orphans = new Map<string, OutputEvent[]>()
  private subscribed: TerminalWorkspaceBridge | null = null
  private unsubscribe: (() => void) | null = null
  private listToken = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = (): TerminalWorkspaceState => this.state

  terminal(id: string): WorkspaceTerminal | undefined { return this.state.terminals.find(item => item.id === id) }
  loadError(id: string): string | null { return this.records.get(id)?.loadError ?? null }
  replaying(id: string): boolean { return this.records.get(id)?.replaying ?? false }
  lastOutputAt(id: string): number { return this.records.get(id)?.lastOutputAt ?? Number.NEGATIVE_INFINITY }
  /** The last line the terminal printed, for its sidebar row while it waits. */
  lastLine(id: string): string { return lastNotableLine(this.records.get(id)?.tail ?? '') }
  pasted(id: string): { readonly path: string; readonly at: number } | null { return this.records.get(id)?.pasted ?? null }

  /** Lists the terminals from main; the first call in a window starts listening for their output. */
  async activate(bridge: TerminalWorkspaceBridge | undefined): Promise<void> {
    if (this.state.status === 'idle') this.set({ ...this.state, status: 'loading' })
    if (!bridge) { this.set({ ...this.state, status: 'error', error: unavailable }); return }
    this.listen(bridge)
    const token = ++this.listToken
    const result = await settle(bridge.list())
    if (token !== this.listToken) return
    if (!result.ok) { this.set({ ...this.state, status: 'error', error: result.error }); return }
    for (const terminal of result.value.terminals) this.ensureRecord(terminal.id)
    this.set({ ...this.state, status: 'ready', error: null, terminals: result.value.terminals, shell: result.value.shell })
  }

  /** Opens a terminal; resolves to its ID once main has started it. */
  async open(bridge: TerminalWorkspaceBridge | undefined, request: TerminalOpenRequest): Promise<{ readonly id: string } | { readonly error: string }> {
    if (!bridge) return { error: unavailable.message }
    this.listen(bridge)
    this.set({ ...this.state, busy: true, notice: null })
    const result = await settle(bridge.open(request))
    if (!result.ok) { this.set({ ...this.state, busy: false }); return { error: this.words(result.error, 'Could not open the terminal.') } }
    this.adopt(result.value)
    this.set({ ...this.state, busy: false })
    return { id: result.value.terminal.id }
  }

  /** The same command again in the same folder; its old output goes. Also brings a closed terminal back. */
  async restart(bridge: TerminalWorkspaceBridge | undefined, id: string): Promise<void> {
    const record = this.records.get(id)
    if (!bridge || !record) return
    this.set({ ...this.state, busy: true, notice: null })
    record.replaying = true
    record.buffer = []
    record.tail = ''
    record.view?.setInputEnabled(false)
    const result = await settle(bridge.restart({ id }))
    if (!result.ok) { record.replaying = false; this.fail(bridge, result.error, 'Could not restart this terminal.'); return }
    this.adopt(result.value)
    this.set({ ...this.state, busy: false })
  }

  async stop(bridge: TerminalWorkspaceBridge | undefined, id: string): Promise<void> {
    if (!bridge) return
    this.set({ ...this.state, notice: null })
    const result = await settle(bridge.stop({ id }))
    if (!result.ok && result.error.code !== 'not-running') this.fail(bridge, result.error, 'Could not stop this terminal.')
  }

  async close(bridge: TerminalWorkspaceBridge | undefined, id: string): Promise<void> {
    if (!bridge) return
    this.set({ ...this.state, busy: true, notice: null })
    const result = await settle(bridge.close({ id }))
    if (!result.ok && result.error.code !== 'session-unavailable') { this.fail(bridge, result.error, 'Could not close this terminal.'); return }
    this.release(id)
    this.set({ ...this.state, busy: false })
  }

  write(bridge: TerminalWorkspaceBridge | undefined, id: string, data: string): void {
    const record = this.records.get(id)
    if (!bridge || !record || record.replaying || this.terminal(id)?.status !== 'running') return
    // Main takes at most 64 KiB per write; a large paste goes in order, chunk by chunk.
    const chunks = data.match(/[\s\S]{1,16384}/gu) ?? []
    void chunks.reduce<Promise<unknown>>((previous, chunk) => previous.then(() => settle(bridge.write({ id, data: chunk }))), Promise.resolve())
  }

  interrupt(bridge: TerminalWorkspaceBridge | undefined, id: string): void {
    if (bridge) void settle(bridge.interrupt({ id }))
  }

  /** Saves the clipboard image under the terminal's folder; main types the path. The path shows in the pane briefly. */
  async pasteImage(bridge: TerminalWorkspaceBridge | undefined, id: string, dataUrl: string): Promise<void> {
    const record = this.records.get(id)
    if (!bridge || !record) return
    const result = await settle(bridge.pasteImage({ id, dataUrl }))
    if (!result.ok) { this.set({ ...this.state, notice: this.words(result.error, 'Could not paste the image.') }); return }
    record.pasted = { path: result.value.path, at: Date.now() }
    this.emit()
  }
  clearPasted(id: string): void {
    const record = this.records.get(id)
    if (record?.pasted) { record.pasted = null; this.emit() }
  }

  /** Sends a new size only when it changed. */
  resize(bridge: TerminalWorkspaceBridge | undefined, id: string, size: { cols: number; rows: number }): void {
    const record = this.records.get(id)
    if (!bridge || !record) return
    const cols = Math.max(2, Math.min(500, size.cols))
    const rows = Math.max(1, Math.min(300, size.rows))
    if (record.size?.cols === cols && record.size.rows === rows) return
    record.size = { cols, rows }
    void settle(bridge.resize({ id, cols, rows }))
  }

  /** Puts the terminal into `container`, reading and replaying its snapshot the first time. */
  attach(bridge: TerminalWorkspaceBridge | undefined, id: string, container: HTMLElement, factory: TerminalViewFactory): TerminalViewLike | null {
    const record = this.ensureRecord(id)
    if (!record.view) {
      record.view = factory({
        onInput: data => this.write(bridge, id, data),
        onInterrupt: () => this.interrupt(bridge, id),
        onPasteImage: dataUrl => void this.pasteImage(bridge, id, dataUrl),
      })
    }
    record.view.mount(container)
    if (record.pending) {
      const snapshot = record.pending
      record.pending = null
      this.replay(record, snapshot)
    } else if (!record.loaded && !record.replaying) void this.load(bridge, id)
    else record.view.setInputEnabled(!record.replaying && this.terminal(id)?.status === 'running')
    return record.view
  }

  detach(id: string): void { this.records.get(id)?.view?.unmount() }

  retry(bridge: TerminalWorkspaceBridge | undefined, id: string): void {
    const record = this.records.get(id)
    if (record && !record.replaying) void this.load(bridge, id)
  }

  private async load(bridge: TerminalWorkspaceBridge | undefined, id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) return
    if (!bridge) { record.loadError = unavailable.message; this.emit(); return }
    this.listen(bridge)
    record.replaying = true
    record.loadError = null
    record.buffer = [...this.orphans.get(id) ?? []]
    this.orphans.delete(id)
    record.view?.setInputEnabled(false)
    this.emit()
    const result = await settle(bridge.read({ id }))
    if (this.records.get(id) !== record) return
    if (!result.ok) {
      record.replaying = false
      record.loadError = result.error.code === 'session-unavailable' ? 'This terminal is no longer available.' : 'The terminal output could not load.'
      if (result.error.code === 'session-unavailable') void this.activate(bridge)
      this.emit()
      return
    }
    this.replay(record, result.value)
  }

  /** Registers a snapshot main just returned (open or restart) and replays it. */
  private adopt(snapshot: WorkspaceTerminalSnapshot): void {
    const id = snapshot.terminal.id
    const record = this.ensureRecord(id)
    const buffered = this.orphans.get(id) ?? []
    this.orphans.delete(id)
    record.buffer = [...record.buffer, ...buffered]
    this.upsert(snapshot.terminal)
    this.replay(record, snapshot)
  }

  private replay(record: TerminalRecord, snapshot: WorkspaceTerminalSnapshot): void {
    this.upsert(snapshot.terminal)
    record.loaded = true
    if (!record.view) {
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
      record.view?.setInputEnabled(this.terminal(snapshot.terminal.id)?.status === 'running')
      this.emit()
    }
    record.view.reset()
    if (snapshot.output) record.view.write(snapshot.output, finish)
    else finish()
  }

  private listen(bridge: TerminalWorkspaceBridge): void {
    if (this.subscribed === bridge) return
    this.unsubscribe?.()
    this.subscribed = bridge
    this.unsubscribe = bridge.onEvent(event => this.receive(event))
  }

  private receive(event: WorkspaceTerminalEvent): void {
    if (event.type === 'output') {
      const record = this.records.get(event.id)
      if (!record) {
        const queue = this.orphans.get(event.id) ?? []
        if (queue.length < ORPHAN_LIMIT) queue.push(event)
        this.orphans.set(event.id, queue)
        return
      }
      record.lastOutputAt = Date.now()
      record.tail = (record.tail + event.data).slice(-TAIL_LIMIT)
      if (record.replaying || !record.loaded || record.pending) { record.buffer.push(event); return }
      if (event.sequence <= record.sequence) return
      record.view?.write(event.data)
      record.sequence = event.sequence
      return
    }
    this.ensureRecord(event.terminal.id)
    this.upsert(event.terminal)
    const record = this.records.get(event.terminal.id)
    if (record && !record.replaying) record.view?.setInputEnabled(event.terminal.status === 'running')
  }

  private upsert(terminal: WorkspaceTerminal): void {
    const index = this.state.terminals.findIndex(item => item.id === terminal.id)
    const terminals = index < 0 ? [...this.state.terminals, terminal] : this.state.terminals.map((item, position) => position === index ? terminal : item)
    this.set({ ...this.state, terminals })
  }

  private release(id: string): void {
    const record = this.records.get(id)
    record?.view?.dispose()
    if (record) record.view = null
    // The record stays for the Closed shelf; only its screen goes.
  }

  private ensureRecord(id: string): TerminalRecord {
    let record = this.records.get(id)
    if (!record) {
      record = { view: null, sequence: 0, replaying: false, buffer: [], loaded: false, pending: null, size: null, loadError: null, lastOutputAt: Number.NEGATIVE_INFINITY, tail: '', pasted: null }
      this.records.set(id, record)
    }
    return record
  }

  private words(error: ToolsError, words: string): string {
    return error.code === 'busy' ? 'Terminal is busy. Try again in a moment.' : `${words} ${error.message}`.trim()
  }

  private fail(bridge: TerminalWorkspaceBridge, error: ToolsError, words: string): void {
    this.set({ ...this.state, busy: false, notice: this.words(error, words) })
    if (error.code === 'session-unavailable') void this.activate(bridge)
  }

  private set(next: TerminalWorkspaceState): void {
    this.state = next
    this.emit()
  }

  private emit(): void { for (const listener of [...this.listeners]) listener() }
}

async function settle<T>(request: Promise<ToolsResult<T>>): Promise<ToolsResult<T>> {
  try { return await request } catch { return { ok: false, error: { code: 'unavailable', message: 'Sotto did not answer.' } } }
}

export function useTerminalWorkspace(store: TerminalWorkspaceStore): TerminalWorkspaceState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/** One store per window: terminals keep running and keep their screens while the page changes. */
export const terminalWorkspaceStore = new TerminalWorkspaceStore()
